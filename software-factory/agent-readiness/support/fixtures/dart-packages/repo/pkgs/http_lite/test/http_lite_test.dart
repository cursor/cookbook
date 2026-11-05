import 'package:http_lite/http_lite.dart';
import 'package:test/test.dart';

void main() {
  test('get', () => expect(get('/x'), 'GET /x'));
}
