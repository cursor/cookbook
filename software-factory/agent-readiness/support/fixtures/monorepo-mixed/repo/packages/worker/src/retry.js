export function backoff(attempt) {
  if (attempt < 1) {
    return 0;
  }
  return Math.min(2 ** attempt * 100, 10000);
}

export function shouldRetry(status, attempt) {
  if (attempt >= 5) {
    return false;
  }
  return status >= 500;
}
