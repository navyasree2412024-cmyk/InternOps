const NON_ACTIVE = new Set([
  'ON_HOLD',
  'COMPLETED',
  'TERMINATED',
  'DISCONTINUED',
]);
function iso(value) {
  return value ? String(value).slice(0, 10) : null;
}
function effectiveEnd(member) {
  if (member.internship_status === 'COMPLETED')
    return iso(
      member.extended_completion_date ||
        member.completion_date ||
        member.lifecycle_effective_date
    );
  if (['TERMINATED', 'DISCONTINUED'].includes(member.internship_status))
    return iso(member.lifecycle_effective_date);
  return null;
}
function activityAllowed(member, date = new Date().toISOString().slice(0, 10)) {
  const status = member.internship_status || 'ACTIVE';
  if (status === 'ACTIVE') return true;
  if (status === 'ON_HOLD') return false;
  const end = effectiveEnd(member);
  if (!end) return false;
  return status === 'COMPLETED' ? date <= end : date < end;
}
function reason(member) {
  const status = member.internship_status || 'ACTIVE';
  if (status === 'ON_HOLD')
    return 'Internship activity is paused while this member is on hold';
  return `Internship activity is unavailable because this member is ${status.toLowerCase()}`;
}
async function getMember(client, id) {
  const { rows } = await client.query(
    `SELECT id, internship_status, lifecycle_effective_date::text,
    completion_date::text, extended_completion_date::text FROM users WHERE id=$1 AND deleted_at IS NULL`,
    [id]
  );
  return rows[0] || null;
}
async function getAllMembers(client, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { rows } = await client.query(
    `SELECT id, internship_status, lifecycle_effective_date::text,
     completion_date::text, extended_completion_date::text
     FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids]
  );
  return rows;
}
async function assertActivityAllowed(client, id, date) {
  const member = await getMember(client, id);
  if (!member)
    throw Object.assign(new Error('Member not found'), { statusCode: 404 });
  if (!activityAllowed(member, date))
    throw Object.assign(new Error(reason(member)), { statusCode: 409 });
  return member;
}
async function assertActivityAllowedBulk(client, entries) {
  const uniqueIds = [...new Set(entries.map((e) => e.user_id))];
  const members = await getAllMembers(client, uniqueIds);

  const membersById = new Map(members.map((member) => [member.id, member]));

  const eligible = [];
  const skipped = [];

  for (const entry of entries) {
    const member = membersById.get(entry.user_id);

    if (!member) {
      skipped.push({
        user_id: entry.user_id,
        date: entry.date,
        reason: 'Member not found',
      });
      continue;
    }

    if (!activityAllowed(member, entry.date)) {
      skipped.push({
        user_id: entry.user_id,
        date: entry.date,
        reason: reason(member),
      });
      continue;
    }

    eligible.push(entry);
  }

  return { eligible, skipped };
}
module.exports = {
  NON_ACTIVE,
  effectiveEnd,
  activityAllowed,
  getMember,
  getAllMembers,
  assertActivityAllowed,
  assertActivityAllowedBulk,
};
