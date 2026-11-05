package inventory

func Available(onHand, reserved int) int {
	if reserved > onHand {
		return 0
	}
	return onHand - reserved
}
