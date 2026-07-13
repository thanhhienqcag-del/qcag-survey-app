'use strict';

const crypto = require('crypto');

function safeJsonParse(str, fallback = []) {
  if (!str) return fallback;
  try {
    const parsed = JSON.parse(str);
    return parsed || fallback;
  } catch (e) {
    return fallback;
  }
}

function isValidCode(code) {
  if (!code) return false;
  const c = String(code).trim().toLowerCase();
  return c && c !== 'chưa có code' && c !== 'new outlet' && c !== 'chuacocode' && c !== 'new_outlet';
}

async function getOrCreatePerson(pool, code, name, phone, type) {
  const cleanCode = code ? String(code).trim() : null;
  const cleanName = name ? String(name).trim() : 'Unknown';
  const cleanPhone = phone ? String(phone).trim() : null;
  const cleanType = type || 'sale';

  try {
    if (cleanCode) {
      // Try get by code
      const res = await pool.query('SELECT id FROM people WHERE person_code = ? LIMIT 1', [cleanCode]);
      if (res && res[0] && res[0].length > 0) return res[0][0].id;
    } else {
      // Try get by name
      const res = await pool.query('SELECT id FROM people WHERE full_name = ? AND person_code IS NULL LIMIT 1', [cleanName]);
      if (res && res[0] && res[0].length > 0) return res[0][0].id;
    }

    // Insert
    const ins = await pool.query(
      `INSERT INTO people (person_code, full_name, phone, person_type) 
       VALUES (?, ?, ?, ?) 
       ON CONFLICT (person_code) WHERE person_code IS NOT NULL 
       DO UPDATE SET full_name = EXCLUDED.full_name, phone = COALESCE(people.phone, EXCLUDED.phone)
       RETURNING id`,
      [cleanCode, cleanName, cleanPhone, cleanType]
    );
    return ins && ins[0] && ins[0].insertId ? ins[0].insertId : null;
  } catch (e) {
    console.error('[dual-write] getOrCreatePerson failed:', e.message);
    return null;
  }
}

async function getOrCreateOutlet(pool, code, name, phone, address, lat, lng, province, district, ward, region, salePersonId) {
  const cleanCode = isValidCode(code) ? String(code).trim() : null;
  const cleanName = name ? String(name).trim() : 'Unknown';
  const cleanPhone = phone ? String(phone).trim() : null;
  const cleanAddress = address ? String(address).trim() : null;
  const cleanLat = lat ? String(lat).trim() : null;
  const cleanLng = lng ? String(lng).trim() : null;

  try {
    if (cleanCode) {
      const res = await pool.query('SELECT id FROM core_outlets WHERE canonical_outlet_code = ? LIMIT 1', [cleanCode]);
      if (res && res[0] && res[0].length > 0) {
        const id = res[0][0].id;
        await pool.query(
          `UPDATE core_outlets SET outlet_name = ?, phone = COALESCE(phone, ?), address = COALESCE(address, ?), 
                                   lat = COALESCE(lat, ?), lng = COALESCE(lng, ?), updated_at = NOW() WHERE id = ?`,
          [cleanName, cleanPhone, cleanAddress, cleanLat, cleanLng, id]
        );
        return id;
      }
    } else {
      const res = await pool.query('SELECT id FROM core_outlets WHERE outlet_name = ? AND address = ? LIMIT 1', [cleanName, cleanAddress]);
      if (res && res[0] && res[0].length > 0) return res[0][0].id;
    }

    // Insert
    const ins = await pool.query(
      `INSERT INTO core_outlets (
         canonical_outlet_code, outlet_name, phone, address, lat, lng, 
         province, district, ward, current_sale_person_id, region
       ) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (canonical_outlet_code) WHERE canonical_outlet_code IS NOT NULL
       DO UPDATE SET outlet_name = EXCLUDED.outlet_name, phone = COALESCE(core_outlets.phone, EXCLUDED.phone)
       RETURNING id`,
      [
        cleanCode, cleanName, cleanPhone, cleanAddress, cleanLat, cleanLng,
        province || null, district || null, ward || null, salePersonId, region || null
      ]
    );
    const id = ins && ins[0] && ins[0].insertId ? ins[0].insertId : null;

    if (id && cleanCode) {
      await pool.query(
        `INSERT INTO outlet_code_aliases (outlet_id, alias_code, alias_type, source_app, is_current)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [id, cleanCode, 'app1_confirmed', 'App-1', true]
      );
    }
    return id;
  } catch (e) {
    console.error('[dual-write] getOrCreateOutlet failed:', e.message);
    return null;
  }
}

/**
 * Synchronize a single quotation record to the new tables.
 */
async function syncQuotation(pool, id) {
  if (!id) return;
  try {
    const [rows] = await pool.query('SELECT * FROM quotations WHERE id = ? LIMIT 1', [id]);
    if (!rows || rows.length === 0) return;
    const q = rows[0];

    const salePersonId = await getOrCreatePerson(pool, q.sale_code, q.sale_name, q.sale_phone, 'sale');
    const ssPersonId = q.ss_name ? await getOrCreatePerson(pool, null, q.ss_name, null, 'ss') : null;
    const createdByPersonId = q.created_by ? await getOrCreatePerson(pool, q.created_by, q.created_by_name, null, 'qcag') : null;

    const outletId = await getOrCreateOutlet(
      pool, q.outlet_code, q.outlet_name, q.outlet_phone, q.address,
      null, null, q.province, q.district, q.ward, q.area, salePersonId
    );

    // Find source tk_code from bridge
    let sourceTkCode = null;
    let bridgeId = null;
    if (q.quote_code) {
      const [bRows] = await pool.query('SELECT id, tk_code FROM ks_quote_bridge WHERE quote_code = ? LIMIT 1', [q.quote_code]);
      if (bRows && bRows.length > 0) {
        sourceTkCode = bRows[0].tk_code ? String(bRows[0].tk_code).trim() : null;
        bridgeId = bRows[0].id;

        // Verify source request exists
        if (sourceTkCode) {
          const [rRows] = await pool.query('SELECT id FROM ks_requests_new WHERE tk_code = ? LIMIT 1', [sourceTkCode]);
          if (!rRows || rRows.length === 0) {
            sourceTkCode = null; // matching request not backfilled yet
          }
        }
      }
    }

    const saleSnapshot = JSON.stringify({
      sale_type: q.sale_type,
      sale_code: q.sale_code,
      sale_name: q.sale_name,
      sale_phone: q.sale_phone,
      ss_name: q.ss_name
    });

    // Upsert into quotations_new
    await pool.query(
      `INSERT INTO quotations_new (
         id, quote_code, source_tk_code, bridge_id, outlet_id, sale_person_id, ss_person_id,
         sale_snapshot, area, total_amount, spo_number, spo_status, quote_status,
         qcag_status, qcag_override_status, qcag_note, qcag_at, created_by_person_id,
         created_by_name_snapshot, created_at, updated_at, qc_signage_state,
         due_date, responsibles, is_confirmed, last_confirmed_at, edit_history,
         is_exported, exported_at, qcag_order_number, order_number, items
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         quote_code = EXCLUDED.quote_code,
         source_tk_code = EXCLUDED.source_tk_code,
         bridge_id = EXCLUDED.bridge_id,
         outlet_id = EXCLUDED.outlet_id,
         sale_person_id = EXCLUDED.sale_person_id,
         ss_person_id = EXCLUDED.ss_person_id,
         sale_snapshot = EXCLUDED.sale_snapshot,
         area = EXCLUDED.area,
         total_amount = EXCLUDED.total_amount,
         spo_number = EXCLUDED.spo_number,
         spo_status = EXCLUDED.spo_status,
         quote_status = EXCLUDED.quote_status,
         qcag_status = EXCLUDED.qcag_status,
         qcag_override_status = EXCLUDED.qcag_override_status,
         qcag_note = EXCLUDED.qcag_note,
         qcag_at = EXCLUDED.qcag_at,
         created_by_person_id = EXCLUDED.created_by_person_id,
         created_by_name_snapshot = EXCLUDED.created_by_name_snapshot,
         updated_at = EXCLUDED.updated_at,
         qc_signage_state = EXCLUDED.qc_signage_state,
         due_date = EXCLUDED.due_date,
         responsibles = EXCLUDED.responsibles,
         is_confirmed = EXCLUDED.is_confirmed,
         last_confirmed_at = EXCLUDED.last_confirmed_at,
         edit_history = EXCLUDED.edit_history,
         is_exported = EXCLUDED.is_exported,
         exported_at = EXCLUDED.exported_at,
         qcag_order_number = EXCLUDED.qcag_order_number,
         order_number = EXCLUDED.order_number,
         items = EXCLUDED.items`,
      [
        q.id, q.quote_code, sourceTkCode, bridgeId, outletId, salePersonId, ssPersonId,
        saleSnapshot, q.area, q.total_amount, q.spo_number, q.spo_status, q.quote_status,
        q.qcag_status, q.qcag_override_status, q.qcag_note, q.qcag_at, createdByPersonId,
        q.created_by_name, q.created_at, q.updated_at, q.qc_signage_state,
        q.due_date, q.responsibles, q.is_confirmed, q.last_confirmed_at, q.edit_history,
        q.is_exported, q.exported_at, q.qcag_order_number, q.order_number, q.items
      ]
    );

    // Parse and sync qc_signage_state JSON to qc_signage_batch_items Neon table
    if (q.qc_signage_state) {
      try {
        const parsedState = JSON.parse(q.qc_signage_state);
        if (parsedState && typeof parsedState === 'object' && parsedState.items && typeof parsedState.items === 'object') {
          // Ensure a default batch exists in qc_signage_batches
          let batchId = null;
          const [batchRows] = await pool.query(
            "SELECT id FROM qc_signage_batches WHERE batch_code = 'default' LIMIT 1"
          );
          if (batchRows && batchRows.length > 0) {
            batchId = batchRows[0].id;
          } else {
            const [insBatch] = await pool.query(
              `INSERT INTO qc_signage_batches (batch_code, name, status, created_at, updated_at)
               VALUES ('default', 'Default Batch', 'active', NOW(), NOW())
               ON CONFLICT (batch_code) DO UPDATE SET updated_at = NOW()
               RETURNING id`
            );
            batchId = insBatch && insBatch.insertId ? insBatch.insertId : null;
            if (!batchId && insBatch && insBatch.length > 0) {
              batchId = insBatch[0].id;
            }
          }

          if (batchId) {
            const orderItems = safeJsonParse(q.items, []);
            const clearedQuoteIds = new Set();
            for (const [key, itemState] of Object.entries(parsedState.items)) {
              if (!itemState || typeof itemState !== 'object') continue;
              const status = itemState.status || 'todo';

              // Key format: orderKey__mid__itemIndex__quoteIndex
              const parts = key.split('__');
              if (parts.length >= 2) {
                let quoteId = null;
                const quoteIndexStr = parts[3];
                if (quoteIndexStr !== undefined) {
                  const quoteIndex = parseInt(quoteIndexStr, 10);
                  if (Number.isInteger(quoteIndex) && quoteIndex >= 0 && quoteIndex < orderItems.length) {
                    const quoteObj = orderItems[quoteIndex];
                    if (quoteObj) {
                      quoteId = quoteObj.quote_id || quoteObj.id;
                    }
                  }
                }

                // Fallback 1: match mid against orderItems fields
                if (!quoteId) {
                  const mid = parts[1];
                  const matchedQuoteObj = orderItems.find(item =>
                    String(item.quote_id || item.id || '') === String(mid) ||
                    String(item.outlet_code || item.outletCode || '') === String(mid) ||
                    String(item.quote_code || item.quoteCode || '') === String(mid) ||
                    String(item.spo_number || item.spoNumber || '') === String(mid)
                  );
                  if (matchedQuoteObj) {
                    quoteId = matchedQuoteObj.quote_id || matchedQuoteObj.id;
                  }
                }

                // Fallback 2: if mid looks like direct quotation ID
                if (!quoteId) {
                  const mid = parts[1];
                  const potentialId = parseInt(mid, 10);
                  if (Number.isInteger(potentialId) && potentialId > 0 && potentialId < 10000000) {
                    const [idRows] = await pool.query('SELECT id FROM quotations_new WHERE id = ? LIMIT 1', [potentialId]);
                    if (idRows && idRows.length > 0) {
                      quoteId = idRows[0].id;
                    }
                  }
                }

                // Fallback 3: look up by quote_code or outlet_code in DB
                if (!quoteId) {
                  const mid = parts[1];
                  const [codeRows] = await pool.query(
                    'SELECT id FROM quotations_new WHERE quote_code = ? OR quote_code = ? LIMIT 1',
                    [mid, String(mid)]
                  );
                  if (codeRows && codeRows.length > 0) {
                    quoteId = codeRows[0].id;
                  } else {
                    const [outletRows] = await pool.query(
                      `SELECT q.id FROM quotations_new q 
                       LEFT JOIN core_outlets o ON o.id = q.outlet_id 
                       WHERE o.canonical_outlet_code = ? LIMIT 1`,
                      [mid]
                    );
                    if (outletRows && outletRows.length > 0) {
                      quoteId = outletRows[0].id;
                    }
                  }
                }

                // Fallback 4: parse q{index} format for parts[1] (legacy key structure)
                if (!quoteId && parts[1] && parts[1].startsWith('q')) {
                  const idx = parseInt(parts[1].slice(1), 10);
                  if (Number.isInteger(idx) && idx >= 0 && idx < orderItems.length) {
                    const quoteObj = orderItems[idx];
                    if (quoteObj) {
                      quoteId = quoteObj.quote_id || quoteObj.id;
                    }
                  }
                }

                if (quoteId) {
                  // Fetch quotation details to populate snapshots in qc_signage_batch_items
                  const [qRows] = await pool.query(
                    `SELECT q.quote_code, q.spo_number, q.outlet_id, o.canonical_outlet_code, o.outlet_name
                     FROM quotations_new q
                     LEFT JOIN core_outlets o ON o.id = q.outlet_id
                     WHERE q.id = ? LIMIT 1`,
                    [quoteId]
                  );

                  if (qRows && qRows.length > 0) {
                    const qData = qRows[0];
                    // Clean up any existing batch items for this (batch, quotation) ONCE to avoid duplicates while allowing multiple items
                    if (!clearedQuoteIds.has(quoteId)) {
                      await pool.query(
                        'DELETE FROM qc_signage_batch_items WHERE batch_id = ? AND quotation_id = ?',
                        [batchId, quoteId]
                      );
                      clearedQuoteIds.add(quoteId);
                    }

                    // Insert the new batch item
                    await pool.query(
                      `INSERT INTO qc_signage_batch_items (
                         batch_id, quotation_id, outlet_id, quote_code_snapshot,
                         outlet_code_snapshot, outlet_name_snapshot, spo_number_snapshot,
                         qc_state, created_at, updated_at
                       )
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                      [
                        batchId, quoteId, qData.outlet_id, qData.quote_code,
                        qData.canonical_outlet_code, qData.outlet_name, qData.spo_number,
                        status
                      ]
                    );
                  }
                }
              }
            }
          }
        }
      } catch (jsonErr) {
        console.error('[dual-write] Failed to parse and sync qc_signage_state JSON:', jsonErr.message);
      }
    }


    // Clean old quotation child items/notes/assets
    await pool.query('DELETE FROM quotation_items WHERE quotation_id = ?', [q.id]);
    await pool.query('DELETE FROM quotation_notes WHERE quotation_id = ?', [q.id]);
    await pool.query('DELETE FROM assets WHERE owner_type = ? AND owner_id = ?', ['quotation', String(q.id)]);

    // Insert items
    const items = safeJsonParse(q.items, []);
    for (let seq = 0; seq < items.length; seq++) {
      const item = items[seq];
      const priceVal = item.price ? parseFloat(String(item.price).replace(/[^\d]/g, '')) || 0 : 0;
      const amountVal = item.total ? parseFloat(String(item.total).replace(/[^\d]/g, '')) || 0 : 0;
      await pool.query(
        `INSERT INTO quotation_items (quotation_id, seq, type, brand, width, height, poles, quantity, unit, unit_price, amount, note, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          q.id, seq + 1, item.content || item.type, item.brand, String(item.width || ''), String(item.height || ''),
          String(item.poles || ''), parseFloat(item.quantity) || 1.0, item.unit || 'm²', priceVal, amountVal, item.note, JSON.stringify(item)
        ]
      );
    }

    // Insert notes
    const notes = safeJsonParse(q.notes, []);
    for (const n of notes) {
      const authorId = await getOrCreatePerson(pool, null, n.author_name, null, 'qcag');
      const isSystem = n.text && n.text.startsWith('[Tự động]');
      await pool.query(
        `INSERT INTO quotation_notes (quotation_id, author_person_id, author_name_snapshot, note_type, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          q.id, authorId, n.author_name, isSystem ? 'system' : 'manual', n.text, new Date(n.at || Date.now()), new Date(n.at || Date.now())
        ]
      );
    }

    if (q.qcag_note) {
      await pool.query(
        `INSERT INTO quotation_notes (quotation_id, author_name_snapshot, note_type, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          q.id, 'QCAG System', 'qc', q.qcag_note, q.qcag_at || q.updated_at || new Date(), q.qcag_at || q.updated_at || new Date()
        ]
      );
    }

    // Insert assets
    const quoteImages = safeJsonParse(q.images, []);
    for (let sortOrder = 0; sortOrder < quoteImages.length; sortOrder++) {
      const img = quoteImages[sortOrder];
      await pool.query(
        `INSERT INTO assets (owner_type, owner_id, asset_type, url, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['quotation', String(q.id), img.name === 'maquette' ? 'design' : 'quote_image', img.data || img.url || '', sortOrder, q.created_at]
      );
    }

    if (q.qcag_image_url) {
      await pool.query(
        `INSERT INTO assets (owner_type, owner_id, asset_type, url, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['quotation', String(q.id), 'qc_signage', q.qcag_image_url, 0, q.qcag_at || q.created_at]
      );
    }

    console.log(`[dual-write] Synced quotation id=${id} successfully.`);
  } catch (err) {
    console.error(`[dual-write] Error syncing quotation id=${id}:`, err);
    throw err;
  }
}

/**
 * Delete a quotation from the new tables.
 */
async function deleteQuotation(pool, id) {
  if (!id) return;
  try {
    await pool.query('DELETE FROM quotations_new WHERE id = ?', [id]);
    console.log(`[dual-write] Deleted quotation id=${id} from quotations_new.`);
    await pool.query('DELETE FROM assets WHERE owner_type = ? AND owner_id = ?', ['quotation', String(id)]);
    console.log(`[dual-write] Deleted assets for quotation id=${id}.`);
  } catch (err) {
    console.error(`[dual-write] Error deleting quotation id=${id}:`, err);
  }
}

/**
 * Synchronize a single request record to the new tables.
 */
async function syncRequest(pool, id) {
  if (!id) return;
  try {
    const [rows] = await pool.query('SELECT * FROM ks_requests WHERE id = ? LIMIT 1', [id]);
    if (!rows || rows.length === 0) return;
    const r = rows[0];

    const reqData = safeJsonParse(r.requester, null);
    const saleCode = reqData ? reqData.saleCode : null;
    const saleName = reqData ? reqData.saleName : null;
    const requesterPersonId = await getOrCreatePerson(pool, saleCode, saleName, reqData ? reqData.phone : r.phone, 'sale');
    const outletId = await getOrCreateOutlet(
      pool, r.outlet_code, r.outlet_name, r.phone, r.address,
      r.outlet_lat, r.outlet_lng, null, null, null, reqData ? reqData.region : null, requesterPersonId
    );

    const tkCode = r.tk_code ? r.tk_code.trim() : `TK_UNKNOWN_${r.id}`;

    // Upsert into ks_requests_new
    await pool.query(
      `INSERT INTO ks_requests_new (
         id, backend_id, tk_code, outlet_id, type, status, requester_person_id, requester_snapshot,
         content, old_content, old_content_extra, editing_requested_at, mq_folder,
         design_created_by, design_created_at, design_last_edited_by, design_last_edited_at,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         backend_id = EXCLUDED.backend_id,
         tk_code = EXCLUDED.tk_code,
         outlet_id = EXCLUDED.outlet_id,
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         requester_person_id = EXCLUDED.requester_person_id,
         requester_snapshot = EXCLUDED.requester_snapshot,
         content = EXCLUDED.content,
         old_content = EXCLUDED.old_content,
         old_content_extra = EXCLUDED.old_content_extra,
         editing_requested_at = EXCLUDED.editing_requested_at,
         mq_folder = EXCLUDED.mq_folder,
         design_created_by = EXCLUDED.design_created_by,
         design_created_at = EXCLUDED.design_created_at,
         design_last_edited_by = EXCLUDED.design_last_edited_by,
         design_last_edited_at = EXCLUDED.design_last_edited_at,
         updated_at = EXCLUDED.updated_at`,
      [
        r.id, r.backend_id, tkCode, outletId, r.type || 'new', r.status || 'pending', requesterPersonId, r.requester,
        r.content, r.old_content || 0, r.old_content_extra, r.editing_requested_at, r.mq_folder,
        r.design_created_by, r.design_created_at, r.design_last_edited_by, r.design_last_edited_at,
        r.created_at, r.updated_at
      ]
    );

    // Clean old request child items/comments/assets
    await pool.query('DELETE FROM ks_request_items WHERE request_tk_code = ?', [tkCode]);
    await pool.query('DELETE FROM request_comments WHERE request_tk_code = ?', [tkCode]);
    await pool.query('DELETE FROM assets WHERE owner_type = ? AND owner_id = ?', ['ks_request', tkCode]);

    // Insert items
    const items = safeJsonParse(r.items, []);
    for (let seq = 0; seq < items.length; seq++) {
      const item = items[seq];
      await pool.query(
        `INSERT INTO ks_request_items (request_tk_code, seq, type, brand, width, height, poles, action, survey, note, other_content, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tkCode, seq + 1, item.type, item.brand, String(item.width || ''), String(item.height || ''),
          String(item.poles || ''), item.action, String(item.survey || ''), item.note, item.otherContent, JSON.stringify(item)
        ]
      );
    }

    // Insert comments
    const comments = safeJsonParse(r.comments, []);
    for (const c of comments) {
      const authorId = await getOrCreatePerson(pool, null, c.author_name || c.author, null, 'sale');
      await pool.query(
        `INSERT INTO request_comments (request_tk_code, author_person_id, author_role, author_name_snapshot, text, comment_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tkCode, authorId, c.author_role || c.role, c.author_name || c.author, c.text || c.body,
          c.comment_type || 'normal', new Date(c.created_at || c.at || Date.now()), new Date(c.created_at || c.at || Date.now())
        ]
      );
    }

    // Insert assets
    const statusImages = safeJsonParse(r.status_images, []);
    for (let sortOrder = 0; sortOrder < statusImages.length; sortOrder++) {
      await pool.query(
        `INSERT INTO assets (owner_type, owner_id, asset_type, url, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['ks_request', tkCode, 'status', statusImages[sortOrder], sortOrder, r.created_at]
      );
    }

    const designImages = safeJsonParse(r.design_images, []);
    for (let sortOrder = 0; sortOrder < designImages.length; sortOrder++) {
      await pool.query(
        `INSERT INTO assets (owner_type, owner_id, asset_type, url, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['ks_request', tkCode, 'design', designImages[sortOrder], sortOrder, r.created_at]
      );
    }

    const acceptanceImages = safeJsonParse(r.acceptance_images, []);
    for (let sortOrder = 0; sortOrder < acceptanceImages.length; sortOrder++) {
      await pool.query(
        `INSERT INTO assets (owner_type, owner_id, asset_type, url, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['ks_request', tkCode, 'acceptance', acceptanceImages[sortOrder], sortOrder, r.created_at]
      );
    }

    console.log(`[dual-write] Synced request id=${id} (tk_code=${tkCode}) successfully.`);
  } catch (err) {
    console.error(`[dual-write] Error syncing request id=${id}:`, err);
    throw err;
  }
}

/**
 * Delete a request from the new tables.
 */
async function deleteRequest(pool, id) {
  if (!id) return;
  try {
    let tkCode = null;
    const [rows] = await pool.query('SELECT tk_code FROM ks_requests_new WHERE id = ? LIMIT 1', [id]);
    if (rows && rows.length > 0) {
      tkCode = rows[0].tk_code;
    } else {
      const [oldRows] = await pool.query('SELECT tk_code FROM ks_requests WHERE id = ? LIMIT 1', [id]);
      if (oldRows && oldRows.length > 0) {
        tkCode = oldRows[0].tk_code;
      }
    }

    await pool.query('DELETE FROM ks_requests_new WHERE id = ?', [id]);
    console.log(`[dual-write] Deleted request id=${id} from ks_requests_new.`);

    if (tkCode) {
      await pool.query('DELETE FROM assets WHERE owner_type = ? AND owner_id = ?', ['ks_request', tkCode]);
      console.log(`[dual-write] Deleted assets for request tk_code=${tkCode}.`);
    }
  } catch (err) {
    console.error(`[dual-write] Error deleting request id=${id}:`, err);
  }
}

/**
 * Synchronize a single production order record.
 */
async function syncProductionOrder(pool, id) {
  if (!id) return;
  try {
    const [rows] = await pool.query('SELECT * FROM production_orders WHERE id = ? LIMIT 1', [id]);
    if (!rows || rows.length === 0) return;
    const po = rows[0];

    // Upsert into production_orders_new
    await pool.query(
      `INSERT INTO production_orders_new (id, order_code, order_number, spo_number, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         order_code = EXCLUDED.order_code,
         order_number = EXCLUDED.order_number,
         spo_number = EXCLUDED.spo_number,
         status = EXCLUDED.status,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at`,
      [
        po.id, po.order_number, po.order_number, po.spo_number, 'pending', po.notes, po.created_at, po.updated_at
      ]
    );

    // Clean old production_order_items
    await pool.query('DELETE FROM production_order_items WHERE production_order_id = ?', [po.id]);

    const quoteKeys = safeJsonParse(po.quote_keys, []);
    let sortOrder = 0;
    for (const quoteCode of quoteKeys) {
      if (!quoteCode) continue;
      // Get the corresponding quotation details to populate snapshots
      const [qRows] = await pool.query('SELECT id, outlet_id, total_amount FROM quotations_new WHERE quote_code = ? LIMIT 1', [quoteCode]);
      if (qRows && qRows.length > 0) {
        const q = qRows[0];
        // Get outlet snapshots
        const [oRows] = await pool.query('SELECT canonical_outlet_code, outlet_name FROM core_outlets WHERE id = ? LIMIT 1', [q.outlet_id]);
        const o = oRows && oRows.length > 0 ? oRows[0] : {};

        await pool.query(
          `INSERT INTO production_order_items (
             production_order_id, quotation_id, quote_code_snapshot, outlet_id_snapshot,
             outlet_code_snapshot, outlet_name_snapshot, total_amount_snapshot, sort_order, created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            po.id, q.id, quoteCode, q.outlet_id,
            o.canonical_outlet_code || null, o.outlet_name || null, q.total_amount, sortOrder++, po.created_at
          ]
        );
      }
    }
    console.log(`[dual-write] Synced production order id=${id} successfully.`);
  } catch (err) {
    console.error(`[dual-write] Error syncing production order id=${id}:`, err);
    throw err;
  }
}

/**
 * Delete a production order.
 */
async function deleteProductionOrder(pool, id) {
  if (!id) return;
  try {
    await pool.query('DELETE FROM production_orders_new WHERE id = ?', [id]);
    console.log(`[dual-write] Deleted production order id=${id} from production_orders_new.`);
  } catch (err) {
    console.error(`[dual-write] Error deleting production order id=${id}:`, err);
  }
}

module.exports = {
  syncQuotation: async () => {},
  deleteQuotation: async () => {},
  syncRequest: async () => {},
  deleteRequest: async () => {},
  syncProductionOrder: async () => {},
  deleteProductionOrder: async () => {}
};
