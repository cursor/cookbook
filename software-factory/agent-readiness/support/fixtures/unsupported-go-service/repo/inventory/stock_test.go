package inventory

import "testing"

func TestAvailable(t *testing.T) {
	cases := []struct{ onHand, reserved, want int }{{10, 3, 7}, {3, 3, 0}, {2, 5, 0}}
	for _, c := range cases {
		if got := Available(c.onHand, c.reserved); got != c.want {
			t.Errorf("Available(%d, %d) = %d, want %d", c.onHand, c.reserved, got, c.want)
		}
	}
}
