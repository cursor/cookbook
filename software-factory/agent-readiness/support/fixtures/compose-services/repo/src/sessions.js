export function sessionKey(userId) {
  if (!userId) {
    throw new TypeError("a session needs a user");
  }
  return `session:${userId}`;
}

export function isExpired(createdAt, ttlSeconds, now) {
  return now - createdAt >= ttlSeconds * 1000;
}

export function remainingSeconds(createdAt, ttlSeconds, now) {
  const left = ttlSeconds - Math.floor((now - createdAt) / 1000);
  if (left < 0) {
    return 0;
  }
  return left;
}

export function displayName(user) {
  if (user.last) {
    return `${user.first} ${user.last}`;
  }
  return user.first;
}
