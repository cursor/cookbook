package main

import (
	"fmt"

	"example.com/acme/inventory-api/inventory"
)

func main() {
	fmt.Println(inventory.Available(10, 3))
}
