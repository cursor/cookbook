import ast
from datetime import date, datetime
from pathlib import Path

import agent as agent_module
from agent import (
    DEFAULT_VOICE,
    DEFAULT_VOICE_MODEL,
    GREETING_TEXT,
    PatientIntakeAgent,
    create_realtime_model,
)
from clinic import create_demo_clinic

NOW = datetime(2026, 9, 2, 9, 0)


def test_agent_exposes_the_eight_patient_intake_tools() -> None:
    intake_agent = PatientIntakeAgent(create_demo_clinic(NOW), greet=False)

    assert {tool.info.name for tool in intake_agent.tools} == {
        "book_appointment",
        "find_open_times",
        "manage_appointment",
        "read_practice_information",
        "record_emergency_escalation",
        "record_previsit_intake",
        "take_message",
        "update_insurance",
    }


def test_session_uses_one_realtime_model_without_cascade_components() -> None:
    tree = ast.parse(Path("src/agent.py").read_text(encoding="utf-8"))
    session_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Subscript)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "AgentSession"
    ]

    assert len(session_calls) == 1
    keywords = {keyword.arg for keyword in session_calls[0].keywords}
    assert "llm" in keywords
    assert keywords.isdisjoint({"stt", "tts", "turn_detection"})
    vad_keyword = next(keyword for keyword in session_calls[0].keywords if keyword.arg == "vad")
    assert isinstance(vad_keyword.value, ast.Constant)
    assert vad_keyword.value.value is None


def test_realtime_model_defaults_and_environment_overrides(monkeypatch) -> None:
    calls: list[dict[str, str]] = []

    def fake_realtime_model(**kwargs):
        calls.append(kwargs)
        return kwargs

    monkeypatch.setattr(agent_module.xai.realtime, "RealtimeModel", fake_realtime_model)
    monkeypatch.delenv("XAI_VOICE_MODEL", raising=False)
    monkeypatch.delenv("XAI_VOICE", raising=False)

    assert create_realtime_model() == {
        "model": DEFAULT_VOICE_MODEL,
        "voice": DEFAULT_VOICE,
    }

    monkeypatch.setenv("XAI_VOICE_MODEL", "future-voice-model")
    monkeypatch.setenv("XAI_VOICE", "Eve")
    assert create_realtime_model() == {
        "model": "future-voice-model",
        "voice": "Eve",
    }
    assert len(calls) == 2


def test_agent_instructions_include_call_time_and_fake_data_disclosure() -> None:
    intake_agent = PatientIntakeAgent(create_demo_clinic(NOW), greet=False)

    assert "Wednesday, September 02, 2026 at 09:00 AM" in intake_agent.instructions
    assert "fake information" in GREETING_TEXT


async def test_new_patient_search_and_booking_use_the_same_identity() -> None:
    clinic = create_demo_clinic(NOW)
    intake_agent = PatientIntakeAgent(clinic, greet=False)

    openings = await intake_agent.find_open_times(
        patient_status="new",
        last_name="Demo",
        date_of_birth="1990-01-01",
    )
    slot_id = next(
        line.split(":", 1)[0] for line in openings.splitlines() if line.startswith("SL-")
    )
    result = await intake_agent.book_appointment(
        patient_status="new",
        first_name="Taylor",
        last_name="Demo",
        date_of_birth="1990-01-01",
        phone="555-0199",
        slot_id=slot_id,
        visit_type="new_problem",
        reason="demo concern",
    )

    patient = clinic.find_patient("Demo", date(1990, 1, 1))
    assert patient.registered_during_call
    assert clinic.scheduled_appointments(patient)
    assert result.startswith("Booked ")


async def test_unrelated_caller_cannot_access_appointment_details() -> None:
    intake_agent = PatientIntakeAgent(create_demo_clinic(NOW), greet=False)

    result = await intake_agent.manage_appointment(
        action="list",
        last_name="Example",
        date_of_birth="1987-04-12",
        caller_relationship="other",
    )

    assert "Do not confirm whether an appointment exists" in result
    assert "APT-" not in result


async def test_intake_and_emergency_tools_write_durable_call_state() -> None:
    clinic = create_demo_clinic(NOW)
    intake_agent = PatientIntakeAgent(clinic, greet=False)

    await intake_agent.record_previsit_intake(
        last_name="Example",
        date_of_birth="1987-04-12",
        chief_complaint="demo concern",
        symptom_duration="one week",
        medications=[],
        allergies=[],
        conditions=[],
        pharmacy="Demo Pharmacy",
    )
    emergency_result = await intake_agent.record_emergency_escalation(
        reported_symptoms="demo emergency",
    )

    patient = clinic.find_patient("Example", date(1987, 4, 12))
    assert patient.chart_id in clinic.intake_records
    assert clinic.emergency_escalations
    assert "Give the appropriate direction" in emergency_result
