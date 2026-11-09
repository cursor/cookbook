import XCTest
@testable import Greeter

final class GreeterTests: XCTestCase {
    func testGreet() {
        XCTAssertEqual(greet("Ada"), "Hello, Ada!")
    }
}
