"""Deterministic in-memory records for the patient-intake example."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Literal

VisitType = Literal[
    "new_problem",
    "annual_physical",
    "well_child",
    "follow_up",
    "telehealth",
]
MessageKind = Literal[
    "prescription_refill",
    "test_results",
    "billing",
    "referral",
    "medical_records",
    "nurse_callback",
]
AppointmentAction = Literal["list", "cancel", "reschedule"]


class ClinicError(ValueError):
    """Raised when an in-memory clinic operation cannot be completed."""


@dataclass(frozen=True, slots=True)
class Provider:
    id: str
    name: str
    sees_children: bool = False
    sees_adults: bool = True
    accepting_new_patients: bool = True

    def accepts(self, patient: Patient, on_date: datetime) -> bool:
        age = patient.age_on(on_date.date())
        return (age < 18 and self.sees_children) or (age >= 18 and self.sees_adults)


@dataclass(slots=True)
class Insurance:
    carrier: str
    member_id: str
    group_number: str = ""


@dataclass(slots=True)
class Patient:
    chart_id: str
    first_name: str
    last_name: str
    date_of_birth: date
    phone: str
    insurance: Insurance | None = None
    registered_during_call: bool = False

    def age_on(self, day: date) -> int:
        return (
            day.year
            - self.date_of_birth.year
            - ((day.month, day.day) < (self.date_of_birth.month, self.date_of_birth.day))
        )


@dataclass(frozen=True, slots=True)
class Slot:
    provider_id: str
    start: datetime

    @property
    def id(self) -> str:
        value = f"{self.provider_id}:{self.start.isoformat()}".encode()
        return f"SL-{hashlib.sha256(value).hexdigest()[:8].upper()}"


@dataclass(slots=True)
class Appointment:
    id: str
    chart_id: str
    provider_id: str
    start: datetime
    visit_type: VisitType
    reason: str
    status: Literal["scheduled", "cancelled"] = "scheduled"

    @property
    def slot(self) -> Slot:
        return Slot(provider_id=self.provider_id, start=self.start)


@dataclass(frozen=True, slots=True)
class Message:
    id: str
    chart_id: str
    kind: MessageKind
    summary: str
    callback_phone: str


@dataclass(slots=True)
class IntakeRecord:
    chart_id: str
    chief_complaint: str
    symptom_duration: str
    medications: list[str]
    allergies: list[str]
    conditions: list[str]
    pharmacy: str


@dataclass(frozen=True, slots=True)
class EmergencyEscalation:
    symptoms: str
    created_at: datetime


@dataclass(slots=True)
class Clinic:
    """A fake family practice whose state lasts for one agent session."""

    now: datetime
    providers: dict[str, Provider]
    patients: list[Patient]
    open_slot_records: dict[str, Slot]
    appointments: dict[str, Appointment] = field(default_factory=dict)
    messages: list[Message] = field(default_factory=list)
    intake_records: dict[str, IntakeRecord] = field(default_factory=dict)
    emergency_escalations: list[EmergencyEscalation] = field(default_factory=list)
    _next_record_number: int = 1

    def find_patient(self, last_name: str, date_of_birth: date) -> Patient:
        for patient in self.patients:
            if (
                patient.last_name.casefold() == last_name.strip().casefold()
                and patient.date_of_birth == date_of_birth
            ):
                return patient
        raise ClinicError("No patient matched that last name and date of birth.")

    def register_patient(
        self,
        *,
        first_name: str,
        last_name: str,
        date_of_birth: date,
        phone: str,
    ) -> Patient:
        if not first_name.strip() or not last_name.strip() or not phone.strip():
            raise ClinicError("A new patient needs a first name, last name, and phone number.")
        patient = Patient(
            chart_id=self._issue_id("MRN"),
            first_name=first_name.strip(),
            last_name=last_name.strip(),
            date_of_birth=date_of_birth,
            phone=phone.strip(),
            registered_during_call=True,
        )
        self.patients.append(patient)
        return patient

    def open_slots(
        self,
        *,
        patient: Patient,
        provider_id: str | None = None,
        preferred_date: date | None = None,
    ) -> list[Slot]:
        if provider_id and provider_id not in self.providers:
            raise ClinicError(f"Unknown provider: {provider_id}.")
        return sorted(
            (
                slot
                for slot in self.open_slot_records.values()
                if slot.start > self.now
                and (provider_id is None or slot.provider_id == provider_id)
                and (preferred_date is None or slot.start.date() == preferred_date)
                and self._provider_can_see(self.providers[slot.provider_id], patient, slot)
            ),
            key=lambda slot: (slot.start, slot.provider_id),
        )

    def book(
        self,
        *,
        patient: Patient,
        slot_id: str,
        visit_type: VisitType,
        reason: str,
    ) -> Appointment:
        slot = self._available_slot(slot_id)
        self._ensure_eligible(patient, slot)
        appointment = Appointment(
            id=self._issue_id("APT"),
            chart_id=patient.chart_id,
            provider_id=slot.provider_id,
            start=slot.start,
            visit_type=visit_type,
            reason=reason.strip(),
        )
        self.open_slot_records.pop(slot_id)
        self.appointments[appointment.id] = appointment
        return appointment

    def register_and_book(
        self,
        *,
        first_name: str,
        last_name: str,
        date_of_birth: date,
        phone: str,
        slot_id: str,
        visit_type: VisitType,
        reason: str,
    ) -> tuple[Patient, Appointment]:
        """Validate a new patient's booking before creating either record."""
        if not first_name.strip() or not last_name.strip() or not phone.strip():
            raise ClinicError("A new patient needs a first name, last name, and phone number.")
        slot = self._available_slot(slot_id)
        prospective_patient = Patient(
            chart_id="pending",
            first_name=first_name.strip(),
            last_name=last_name.strip(),
            date_of_birth=date_of_birth,
            phone=phone.strip(),
            registered_during_call=True,
        )
        self._ensure_eligible(prospective_patient, slot)

        patient = self.register_patient(
            first_name=first_name,
            last_name=last_name,
            date_of_birth=date_of_birth,
            phone=phone,
        )
        appointment = self.book(
            patient=patient,
            slot_id=slot_id,
            visit_type=visit_type,
            reason=reason,
        )
        return patient, appointment

    def scheduled_appointments(self, patient: Patient) -> list[Appointment]:
        return sorted(
            (
                appointment
                for appointment in self.appointments.values()
                if appointment.chart_id == patient.chart_id
                and appointment.status == "scheduled"
                and appointment.start > self.now
            ),
            key=lambda appointment: appointment.start,
        )

    def cancel(self, *, patient: Patient, appointment_id: str) -> Appointment:
        appointment = self._patient_appointment(patient, appointment_id)
        appointment.status = "cancelled"
        self.open_slot_records[appointment.slot.id] = appointment.slot
        return appointment

    def reschedule(
        self,
        *,
        patient: Patient,
        appointment_id: str,
        new_slot_id: str,
    ) -> Appointment:
        appointment = self._patient_appointment(patient, appointment_id)
        new_slot = self._available_slot(new_slot_id)
        self._ensure_eligible(patient, new_slot)
        previous_slot = appointment.slot
        self.open_slot_records.pop(new_slot_id)
        self.open_slot_records[previous_slot.id] = previous_slot
        appointment.provider_id = new_slot.provider_id
        appointment.start = new_slot.start
        return appointment

    def update_insurance(
        self,
        *,
        patient: Patient,
        carrier: str,
        member_id: str,
        group_number: str,
    ) -> Insurance:
        if not carrier.strip() or not member_id.strip():
            raise ClinicError("Carrier and member ID are required.")
        patient.insurance = Insurance(
            carrier=carrier.strip(),
            member_id=member_id.strip(),
            group_number=group_number.strip(),
        )
        return patient.insurance

    def take_message(
        self,
        *,
        patient: Patient,
        kind: MessageKind,
        summary: str,
        callback_phone: str,
    ) -> Message:
        existing = next(
            (
                message
                for message in self.messages
                if message.chart_id == patient.chart_id and message.kind == kind
            ),
            None,
        )
        if existing is not None:
            return existing
        message = Message(
            id=self._issue_id("MSG"),
            chart_id=patient.chart_id,
            kind=kind,
            summary=summary.strip(),
            callback_phone=callback_phone.strip() or patient.phone,
        )
        self.messages.append(message)
        return message

    def record_intake(
        self,
        *,
        patient: Patient,
        chief_complaint: str,
        symptom_duration: str,
        medications: list[str],
        allergies: list[str],
        conditions: list[str],
        pharmacy: str,
    ) -> IntakeRecord:
        record = IntakeRecord(
            chart_id=patient.chart_id,
            chief_complaint=chief_complaint.strip(),
            symptom_duration=symptom_duration.strip(),
            medications=medications,
            allergies=allergies,
            conditions=conditions,
            pharmacy=pharmacy.strip(),
        )
        self.intake_records[patient.chart_id] = record
        return record

    def record_emergency(self, symptoms: str) -> EmergencyEscalation:
        escalation = EmergencyEscalation(
            symptoms=symptoms.strip(),
            created_at=self.now,
        )
        self.emergency_escalations.append(escalation)
        return escalation

    def _issue_id(self, prefix: str) -> str:
        value = f"{prefix}-{self._next_record_number:04d}"
        self._next_record_number += 1
        return value

    def _available_slot(self, slot_id: str) -> Slot:
        try:
            return self.open_slot_records[slot_id]
        except KeyError as error:
            raise ClinicError("That appointment time is no longer available.") from error

    def _patient_appointment(self, patient: Patient, appointment_id: str) -> Appointment:
        try:
            appointment = self.appointments[appointment_id]
        except KeyError as error:
            raise ClinicError("That appointment could not be found.") from error
        if appointment.chart_id != patient.chart_id:
            raise ClinicError("That appointment does not belong to this patient.")
        if appointment.status != "scheduled":
            raise ClinicError("That appointment is no longer scheduled.")
        return appointment

    def _provider_can_see(self, provider: Provider, patient: Patient, slot: Slot) -> bool:
        return provider.accepts(patient, slot.start) and (
            not patient.registered_during_call or provider.accepting_new_patients
        )

    def _ensure_eligible(self, patient: Patient, slot: Slot) -> None:
        provider = self.providers[slot.provider_id]
        if not self._provider_can_see(provider, patient, slot):
            raise ClinicError(f"{provider.name} cannot see this patient.")


def _next_weekdays(now: datetime, count: int) -> list[date]:
    days: list[date] = []
    current = now.date()
    while len(days) < count:
        current += timedelta(days=1)
        if current.weekday() < 5:
            days.append(current)
    return days


def create_demo_clinic(now: datetime) -> Clinic:
    """Create fresh fake records for a single call."""
    providers = {
        "rivera": Provider(
            id="rivera",
            name="Doctor Maya Rivera",
            sees_children=False,
            accepting_new_patients=True,
        ),
        "patel": Provider(
            id="patel",
            name="Doctor Nikhil Patel",
            sees_children=False,
            accepting_new_patients=False,
        ),
        "nguyen": Provider(
            id="nguyen",
            name="Doctor Linh Nguyen",
            sees_children=True,
            sees_adults=False,
            accepting_new_patients=True,
        ),
    }
    patients = [
        Patient(
            chart_id="MRN-DEMO-1",
            first_name="Jamie",
            last_name="Example",
            date_of_birth=date(1987, 4, 12),
            phone="555-0101",
            insurance=Insurance(carrier="Example Health", member_id="DEMO-1001"),
        ),
        Patient(
            chart_id="MRN-DEMO-2",
            first_name="Riley",
            last_name="Example",
            date_of_birth=date(2018, 9, 3),
            phone="555-0102",
        ),
    ]
    slots = [
        Slot(
            provider_id=provider.id,
            start=datetime.combine(day, appointment_time, tzinfo=now.tzinfo),
        )
        for day in _next_weekdays(now, 5)
        for provider in providers.values()
        for appointment_time in (time(9, 30), time(14, 0))
    ]
    clinic = Clinic(
        now=now,
        providers=providers,
        patients=patients,
        open_slot_records={slot.id: slot for slot in slots},
        _next_record_number=100,
    )
    existing_slot = next(
        slot for slot in clinic.open_slot_records.values() if slot.provider_id == "rivera"
    )
    clinic.book(
        patient=patients[0],
        slot_id=existing_slot.id,
        visit_type="follow_up",
        reason="demo follow-up",
    )
    return clinic
