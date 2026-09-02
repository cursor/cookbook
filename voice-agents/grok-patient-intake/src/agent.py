"""Run a Grok speech-to-speech patient-intake agent with LiveKit."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, datetime

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    ToolError,
    cli,
    function_tool,
)
from livekit.plugins import xai

from clinic import (
    AppointmentAction,
    Clinic,
    ClinicError,
    MessageKind,
    Patient,
    VisitType,
    create_demo_clinic,
)

AGENT_NAME = "grok-patient-intake"
DEFAULT_VOICE_MODEL = "grok-voice-latest"
DEFAULT_VOICE = "Ara"

PRACTICE_INFORMATION = """
Maplewood Family Medicine is a fictional teaching clinic at 100 Demo Avenue.
The office is open Monday through Friday from 8:30 AM to 5:00 PM and is closed
on weekends. Routine refill requests are reviewed within two business days.
Only a clinician may interpret test results or give medical advice. Billing,
records, referrals, and nurse questions can be routed as messages. For a
life-threatening emergency, callers must call 911; for an immediate mental
health crisis in the United States, callers should call or text 988.
""".strip()

BASE_INSTRUCTIONS = """
You are the automated patient-intake assistant for Maplewood Family Medicine,
a fictional clinic used only for this software demo. You are not a clinician.

Voice style:
- Sound warm, calm, and concise. Use one or two short sentences at a time.
- Ask one question at a time and wait for the answer.
- Speak naturally without markdown, bullets, code, IDs, or tool names.
- Do not repeat sensitive details such as a date of birth unless correction is needed.

Workflow:
- Retain facts the caller has already supplied and never invent missing values.
- Use a tool for every clinic fact lookup or state change.
- Never claim that an appointment, message, insurance update, or intake was saved
  unless the corresponding tool succeeded.
- Before appointment searches, learn whether the patient is new or established,
  their first and last name, and date of birth.
- Offer only appointment times returned by find_open_times. Keep slot and
  appointment IDs private, and pass the chosen IDs only to tools.
- Collect pre-visit answers one at a time. Do not diagnose or reinterpret them.
- Do not give medical advice, approve refills, interpret results, or quote prices.

Safety:
- If the caller describes a possible emergency, call record_emergency_escalation
  immediately and stop ordinary intake.
- For a medical emergency, direct them to call 911 now and not drive themselves.
- For imminent self-harm or harm to others in the United States, direct them to
  call or text 988 now, and call 911 if anyone is in immediate danger.
- Ordinary symptoms without emergency warning signs should be handled as an
  appointment or nurse message, not an emergency.
""".strip()

GREETING_INSTRUCTIONS = (
    "In one short sentence, identify yourself as Maplewood Family Medicine's "
    "automated assistant and ask how you can help."
)


def _parse_date(value: str, field_name: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ToolError(f"{field_name} must be a real date in YYYY-MM-DD format.") from error


def _format_time(value: datetime) -> str:
    hour = value.hour % 12 or 12
    return f"{value:%A, %B} {value.day} at {hour}:{value:%M %p}"


@dataclass(slots=True)
class CallState:
    clinic: Clinic


class PatientIntakeAgent(Agent):
    """One conversational agent with a fixed, auditable clinic tool surface."""

    def __init__(self, clinic: Clinic, *, greet: bool = True) -> None:
        super().__init__(instructions=BASE_INSTRUCTIONS)
        self.clinic = clinic
        self.greet = greet
        self._new_patient_searches: set[tuple[str, date]] = set()

    async def on_enter(self) -> None:
        if self.greet:
            self.session.generate_reply(instructions=GREETING_INSTRUCTIONS)

    def _patient(self, last_name: str, date_of_birth: str) -> Patient:
        try:
            return self.clinic.find_patient(
                last_name,
                _parse_date(date_of_birth, "date_of_birth"),
            )
        except ClinicError as error:
            raise ToolError(
                "No patient matched that last name and date of birth. Ask the caller "
                "to check both details once; do not guess."
            ) from error

    @function_tool
    async def read_practice_information(self) -> str:
        """Read the complete fictional practice guide before answering policy questions."""
        return PRACTICE_INFORMATION

    @function_tool
    async def find_open_times(
        self,
        patient_status: str,
        last_name: str,
        date_of_birth: str,
        provider_id: str = "",
        preferred_date: str = "",
    ) -> str:
        """Find suitable appointment openings for a caller.

        Args:
            patient_status: Either new or established, based on what the caller said.
            last_name: Patient's actual surname.
            date_of_birth: Full date of birth in YYYY-MM-DD format.
            provider_id: Optional provider ID: rivera, patel, or nguyen.
            preferred_date: Optional exact date in YYYY-MM-DD format.
        """
        born = _parse_date(date_of_birth, "date_of_birth")
        if patient_status not in {"new", "established"}:
            raise ToolError("patient_status must be new or established.")

        if patient_status == "established":
            patient = self._patient(last_name, date_of_birth)
        else:
            try:
                patient = self.clinic.find_patient(last_name, born)
            except ClinicError:
                patient = Patient(
                    chart_id="pending",
                    first_name="pending",
                    last_name=last_name,
                    date_of_birth=born,
                    phone="pending",
                    registered_during_call=True,
                )
                self._new_patient_searches.add((last_name.strip().casefold(), born))

        on_date = _parse_date(preferred_date, "preferred_date") if preferred_date else None
        try:
            slots = self.clinic.open_slots(
                patient=patient,
                provider_id=provider_id or None,
                preferred_date=on_date,
            )
        except ClinicError as error:
            raise ToolError(str(error)) from error

        if not slots:
            return "No suitable appointment times are available for that request."
        return "Available times:\n" + "\n".join(
            f"{slot.id}: {_format_time(slot.start)} with "
            f"{self.clinic.providers[slot.provider_id].name}"
            for slot in slots[:3]
        )

    @function_tool
    async def book_appointment(
        self,
        patient_status: str,
        first_name: str,
        last_name: str,
        date_of_birth: str,
        phone: str,
        slot_id: str,
        visit_type: VisitType,
        reason: str,
    ) -> str:
        """Book a time returned by find_open_times.

        Args:
            patient_status: Either new or established.
            first_name: Patient's first name.
            last_name: Patient's surname.
            date_of_birth: Full date of birth in YYYY-MM-DD format.
            phone: Callback phone. Required for a new patient.
            slot_id: Private slot ID returned by find_open_times.
            visit_type: new_problem, annual_physical, well_child, follow_up, or telehealth.
            reason: Brief caller-described reason without diagnosis.
        """
        born = _parse_date(date_of_birth, "date_of_birth")
        try:
            patient = self.clinic.find_patient(last_name, born)
        except ClinicError:
            if patient_status != "new":
                raise ToolError(
                    "No established patient matched those details. Check them before booking."
                ) from None
            if (last_name.strip().casefold(), born) not in self._new_patient_searches:
                raise ToolError(
                    "Call find_open_times with these patient details before booking."
                ) from None
            try:
                patient = self.clinic.register_patient(
                    first_name=first_name,
                    last_name=last_name,
                    date_of_birth=born,
                    phone=phone,
                )
            except ClinicError as error:
                raise ToolError(str(error)) from error

        try:
            appointment = self.clinic.book(
                patient=patient,
                slot_id=slot_id,
                visit_type=visit_type,
                reason=reason,
            )
        except ClinicError as error:
            raise ToolError(str(error)) from error
        provider = self.clinic.providers[appointment.provider_id]
        return f"Booked {_format_time(appointment.start)} with {provider.name}."

    @function_tool
    async def manage_appointment(
        self,
        action: AppointmentAction,
        last_name: str,
        date_of_birth: str,
        appointment_id: str = "",
        new_slot_id: str = "",
    ) -> str:
        """List, cancel, or reschedule an established patient's appointments.

        Args:
            action: list, cancel, or reschedule.
            last_name: Patient's surname.
            date_of_birth: Full date of birth in YYYY-MM-DD format.
            appointment_id: Private appointment ID for cancel or reschedule.
            new_slot_id: Private slot ID from find_open_times for reschedule.
        """
        patient = self._patient(last_name, date_of_birth)
        if action == "list":
            appointments = self.clinic.scheduled_appointments(patient)
            if not appointments:
                return "No upcoming appointments are scheduled."
            return "Upcoming appointments:\n" + "\n".join(
                f"{appointment.id}: {_format_time(appointment.start)} with "
                f"{self.clinic.providers[appointment.provider_id].name}"
                for appointment in appointments
            )

        if not appointment_id:
            raise ToolError("appointment_id is required after listing appointments.")
        try:
            if action == "cancel":
                appointment = self.clinic.cancel(
                    patient=patient,
                    appointment_id=appointment_id,
                )
                return f"Cancelled the appointment on {_format_time(appointment.start)}."
            if action != "reschedule":
                raise ToolError("action must be list, cancel, or reschedule.")
            if not new_slot_id:
                raise ToolError("new_slot_id is required after finding a new time.")
            appointment = self.clinic.reschedule(
                patient=patient,
                appointment_id=appointment_id,
                new_slot_id=new_slot_id,
            )
        except ClinicError as error:
            raise ToolError(str(error)) from error
        provider = self.clinic.providers[appointment.provider_id]
        return f"Rescheduled to {_format_time(appointment.start)} with {provider.name}."

    @function_tool
    async def take_message(
        self,
        last_name: str,
        date_of_birth: str,
        kind: MessageKind,
        summary: str,
        callback_phone: str = "",
    ) -> str:
        """Route a refill, results, billing, referral, records, or nurse request.

        Args:
            last_name: Patient's surname.
            date_of_birth: Full date of birth in YYYY-MM-DD format.
            kind: Destination queue for the message.
            summary: Brief factual request in the caller's own terms.
            callback_phone: Caller-supplied callback phone, or empty to use the chart.
        """
        patient = self._patient(last_name, date_of_birth)
        before = len(self.clinic.messages)
        message = self.clinic.take_message(
            patient=patient,
            kind=kind,
            summary=summary,
            callback_phone=callback_phone,
        )
        if len(self.clinic.messages) == before:
            return f"A {message.kind.replace('_', ' ')} message is already pending."
        return f"Routed the {message.kind.replace('_', ' ')} request."

    @function_tool
    async def update_insurance(
        self,
        last_name: str,
        date_of_birth: str,
        carrier: str,
        member_id: str,
        group_number: str = "",
    ) -> str:
        """Save insurance details read from an established patient's current card."""
        patient = self._patient(last_name, date_of_birth)
        try:
            insurance = self.clinic.update_insurance(
                patient=patient,
                carrier=carrier,
                member_id=member_id,
                group_number=group_number,
            )
        except ClinicError as error:
            raise ToolError(str(error)) from error
        return f"Updated the insurance to {insurance.carrier}."

    @function_tool
    async def record_previsit_intake(
        self,
        last_name: str,
        date_of_birth: str,
        chief_complaint: str,
        symptom_duration: str,
        medications: list[str],
        allergies: list[str],
        conditions: list[str],
        pharmacy: str,
    ) -> str:
        """Save a complete set of caller-provided pre-visit answers."""
        patient = self._patient(last_name, date_of_birth)
        self.clinic.record_intake(
            patient=patient,
            chief_complaint=chief_complaint,
            symptom_duration=symptom_duration,
            medications=medications,
            allergies=allergies,
            conditions=conditions,
            pharmacy=pharmacy,
        )
        return "Saved the pre-visit answers."

    @function_tool
    async def record_emergency_escalation(self, reported_symptoms: str) -> str:
        """Record a possible emergency before giving the required 911 or 988 direction."""
        self.clinic.record_emergency(reported_symptoms)
        return "Emergency escalation recorded. Give the appropriate direction and stop intake."


def create_realtime_model() -> xai.realtime.RealtimeModel:
    """Create the single speech-to-speech model used for listening and speaking."""
    return xai.realtime.RealtimeModel(
        model=os.getenv("XAI_VOICE_MODEL", DEFAULT_VOICE_MODEL),
        voice=os.getenv("XAI_VOICE", DEFAULT_VOICE),
    )


def create_session(clinic: Clinic) -> AgentSession[CallState]:
    """Compose LiveKit around one native xAI realtime model, with no cascade."""
    return AgentSession[CallState](
        userdata=CallState(clinic=clinic),
        llm=create_realtime_model(),
        max_tool_steps=8,
    )


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def patient_intake(ctx: JobContext) -> None:
    clinic = create_demo_clinic(datetime.now())
    session = create_session(clinic)
    await session.start(
        agent=PatientIntakeAgent(clinic),
        room=ctx.room,
    )
    await ctx.connect()


if __name__ == "__main__":
    load_dotenv(".env.local")
    cli.run_app(server)
