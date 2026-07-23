function resolveKsRequestsOptions(query) {
  const rawValue = query && (query.updated_since || query.updatedSince);
  const updatedSinceRaw = typeof rawValue === 'string' ? rawValue : '';

  let updatedSince = null;
  if (updatedSinceRaw) {
    const parsed = new Date(updatedSinceRaw);
    if (!Number.isNaN(parsed.getTime())) {
      updatedSince = parsed;
    }
  }

  return { updatedSinceRaw, updatedSince };
}

module.exports = { resolveKsRequestsOptions };
