package inventory

// Available is what can still be sold once reserved units are set aside.
func Available(onHand, reserved int) int {
	if reserved >= onHand {
		return 0
	}
	return onHand - reserved
}
