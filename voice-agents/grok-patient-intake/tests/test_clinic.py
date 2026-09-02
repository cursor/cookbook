from datetime import date, datetime

import pytest

from clinic import ClinicError, create_demo_clinic

NOW = datetime(2026, 9, 2, 9, 0)


def test_demo_clinic_is_fresh_and_uses_only_fake_records() -> None:
    first = create_demo_clinic(NOW)
    second = create_demo_clinic(NOW)
    first.patients[0].first_name = "Changed"

    assert second.patients[0].first_name == "Jamie"
    assert all("DEMO" in patient.chart_id for patient in second.patients)
    assert second.open_slot_records


def test_booking_rescheduling_and_cancellation_move_real_slots() -> None:
    clinic = create_demo_clinic(NOW)
    patient = clinic.find_patient("Example", date(1987, 4, 12))
    original_appointment = clinic.scheduled_appointments(patient)[0]
    destination = clinic.open_slots(patient=patient)[0]

    clinic.reschedule(
        patient=patient,
        appointment_id=original_appointment.id,
        new_slot_id=destination.id,
    )
    assert original_appointment.slot == destination

    clinic.cancel(patient=patient, appointment_id=original_appointment.id)
    assert original_appointment.status == "cancelled"
    assert destination in clinic.open_slot_records.values()


def test_new_adult_patient_cannot_book_with_closed_or_pediatric_provider() -> None:
    clinic = create_demo_clinic(NOW)
    patient = clinic.register_patient(
        first_name="Taylor",
        last_name="Demo",
        date_of_birth=date(1990, 1, 1),
        phone="555-0199",
    )

    available = clinic.open_slots(patient=patient)
    assert {slot.provider_id for slot in available} == {"rivera"}

    closed_slot = next(
        slot for slot in clinic.open_slot_records.values() if slot.provider_id == "patel"
    )
    with pytest.raises(ClinicError, match="cannot see"):
        clinic.book(
            patient=patient,
            slot_id=closed_slot.id,
            visit_type="new_problem",
            reason="demo concern",
        )


def test_failed_new_patient_booking_does_not_leave_a_chart() -> None:
    clinic = create_demo_clinic(NOW)
    patient_count = len(clinic.patients)

    with pytest.raises(ClinicError, match="no longer available"):
        clinic.register_and_book(
            first_name="Taylor",
            last_name="Demo",
            date_of_birth=date(1990, 1, 1),
            phone="555-0199",
            slot_id="SL-NOT-REAL",
            visit_type="new_problem",
            reason="demo concern",
        )

    assert len(clinic.patients) == patient_count


def test_messages_are_deduplicated_by_patient_and_kind() -> None:
    clinic = create_demo_clinic(NOW)
    patient = clinic.find_patient("Example", date(1987, 4, 12))

    first = clinic.take_message(
        patient=patient,
        kind="prescription_refill",
        summary="Demo refill",
        callback_phone="",
    )
    second = clinic.take_message(
        patient=patient,
        kind="prescription_refill",
        summary="Duplicate demo refill",
        callback_phone="",
    )

    assert first is second
    assert len(clinic.messages) == 1
    assert first.callback_phone == patient.phone


def test_insurance_intake_and_emergency_records_are_mutated_in_memory() -> None:
    clinic = create_demo_clinic(NOW)
    patient = clinic.find_patient("Example", date(1987, 4, 12))

    clinic.update_insurance(
        patient=patient,
        carrier="Demo Health",
        member_id="DEMO-2002",
        group_number="GROUP-DEMO",
    )
    intake = clinic.record_intake(
        patient=patient,
        chief_complaint="demo knee pain",
        symptom_duration="two days",
        medications=[],
        allergies=[],
        conditions=[],
        pharmacy="Demo Pharmacy",
    )
    escalation = clinic.record_emergency("demo emergency")

    assert patient.insurance and patient.insurance.carrier == "Demo Health"
    assert clinic.intake_records[patient.chart_id] is intake
    assert clinic.emergency_escalations == [escalation]
