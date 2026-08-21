function membershipExpiryDate({ newMember = false, now = new Date() } = {}) {
  let year = now.getFullYear();
  if (newMember && now.getMonth() >= 6) year += 1;
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();
}

module.exports = { membershipExpiryDate };
