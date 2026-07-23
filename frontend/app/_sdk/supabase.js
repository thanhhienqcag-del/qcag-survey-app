/* _sdk/supabase.js
   Client-side Supabase helper. Exposes `window.supabaseClient` and `window.supabaseApi`.
   Uses project URL and anon key provided by the user. For production, move keys
   to environment variables and/or use server-side endpoints for privileged ops.
*/
(function () {
  // Prefer runtime-injected values (window.__env or meta tags) so we don't
  // have to keep keys hard-coded in source. Fall back to the existing values
  // for local convenience.
  const metaUrl = (typeof document !== 'undefined' && document.querySelector('meta[name="supabase-url"]'))
    ? document.querySelector('meta[name="supabase-url"]').content
    : null;
  const metaKey = (typeof document !== 'undefined' && document.querySelector('meta[name="supabase-anon-key"]'))
    ? document.querySelector('meta[name="supabase-anon-key"]').content
    : null;

  const SUPABASE_URL = (typeof window !== 'undefined' && window.__env && window.__env.SUPABASE_URL) || metaUrl || 'https://kuflixiicocxhdwzfxct.supabase.co';
  const SUPABASE_ANON_KEY = (typeof window !== 'undefined' && window.__env && window.__env.SUPABASE_ANON_KEY) || metaKey || 'sb_publishable_HnObLflcqXh_8qjAFVjAaA_PV_eGJY7';

  if (typeof window === 'undefined') return;

  if (!window.supabase) {
    console.warn('Supabase JS not found. Include CDN: https://cdn.jsdelivr.net/npm/@supabase/supabase-js');
    return;
  }

  window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ── Helpers: convert between app (camelCase) ↔ Supabase (snake_case + metadata) ──

  function _toDbRow(appRecord) {
    // Known scalar columns in the Supabase `requests` table
    const row = {
      outlet_code: appRecord.outletCode || null,
      outlet_name: appRecord.outletName || null,
      phone:       appRecord.phone || null,
      address:     appRecord.address || null,
      status:      appRecord.status || 'pending',
      created_at:  appRecord.createdAt || new Date().toISOString()
    };
    // Store everything else (items, images, type, lat/lng, requester…) in metadata
    const KNOWN = new Set(['outletCode','outletName','phone','address','status','createdAt','id','__backendId']);
    const meta = {};
    for (const k of Object.keys(appRecord)) {
      if (!KNOWN.has(k)) meta[k] = appRecord[k];
    }
    // Always keep __backendId in metadata so we can round-trip it
    if (appRecord.__backendId) meta.__backendId = appRecord.__backendId;
    row.metadata = meta;
    return row;
  }

  function _fromDbRow(row) {
    if (!row) return null;
    const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
    return Object.assign({}, meta, {
      id:          row.id,
      __backendId: meta.__backendId || ('srv_' + row.id),
      outletCode:  row.outlet_code  || meta.outletCode  || '',
      outletName:  row.outlet_name  || meta.outletName  || '',
      phone:       row.phone        || meta.phone       || '',
      address:     row.address      || meta.address     || '',
      status:      row.status       || meta.status      || 'pending',
      createdAt:   row.created_at   || meta.createdAt   || ''
    });
  }

  window.supabaseApi = {
    fetchRequests: async function () {
      const resp = await window.supabaseClient.from('requests').select('*').order('created_at', { ascending: false });
      if (resp.error) return resp;
      return { data: (resp.data || []).map(_fromDbRow), error: null };
    },
    createRequest: async function (record) {
      const row = _toDbRow(record);
      const resp = await window.supabaseClient.from('requests').insert([row]).select();
      if (resp.error) return resp;
      const inserted = resp.data && resp.data[0] ? _fromDbRow(resp.data[0]) : record;
      return { data: [inserted], error: null };
    },
    updateRequest: async function (record) {
      try {
        const row = _toDbRow(record);
        if (record && record.id) {
          const resp = await window.supabaseClient.from('requests').update(row).eq('id', record.id).select();
          if (resp.error) return resp;
          const updated = resp.data && resp.data[0] ? _fromDbRow(resp.data[0]) : record;
          return { data: [updated], error: null };
        } else {
          // Fallback: insert if no `id`
          const resp = await window.supabaseClient.from('requests').insert([row]).select();
          if (resp.error) return resp;
          const inserted = resp.data && resp.data[0] ? _fromDbRow(resp.data[0]) : record;
          return { data: [inserted], error: null };
        }
      } catch (e) {
        return { error: e };
      }
    },
    uploadAttachment: async function (file) {
      const bucket = 'attachments';
      const path = `${Date.now()}_${file.name}`;
      const { data, error } = await window.supabaseClient.storage.from(bucket).upload(path, file, { upsert: false });
      if (error) throw error;
      const publicUrl = window.supabaseClient.storage.from(bucket).getPublicUrl(path).publicURL;
      return { path, publicUrl };
    }
  };
})();
