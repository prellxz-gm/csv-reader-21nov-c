// Tick-Hunter: a fast drop-in for csv-reader 1.0.0.
//
// The reading is the reference's, byte for byte: a U+FEFF at the very start is
// dropped, a record ends at LF or CRLF, a line left with no characters is no
// record, a CR outside quotes that is not followed by LF is dropped (stray_cr),
// a field that opens with a quote runs to the next quote that is not doubled
// ("" inside is one quote, CRLF or a lone CR inside is one LF, junk after the
// closing quote is appended as it stands with quote_junk when the field ends,
// a quote that never closes is a literal and the rest is re-read as unquoted
// with unterminated_quote), a quote inside an unquoted field is a literal,
// fields stay strings, columns is the first record when header is true, rows are
// the rest padded with "" (short_row) or cut (long_row) to the first record's
// width, and every error is {code, line, row} in the order met, line the
// 1-based line its record starts on and row its index in rows (null for the
// header).
//
// How it is fast: the text is scanned by native indexOf and slice, never one
// character at a time on the common paths. A single pre-pass collects every
// '\r' position, so testing a field for a stray CR is one integer compare
// against a cached count. The next '\n' is cached per line, together with
// whether that line ends in CRLF, so an unquoted field costs one indexOf(',')
// plus one slice. A quoted field costs one indexOf('"') to find its close
// (doubled quotes skipped in pairs) plus one slice when its content holds no
// line break and no lone CR. Only the rare broken shapes — a stray CR inside
// an unquoted field, a quoted field holding line breaks, junk after a closing
// quote, a quote that never closes — fall back to a careful reader.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  // Every '\r' in the text, in order. Stray CRs are rare, but finding one
  // must not rescan the file, so the positions are collected once here.
  const crs = [];
  let ci = text.indexOf('\r');
  while (ci !== -1) {
    crs.push(ci);
    ci = text.indexOf('\r', ci + 1);
  }
  let crIdx = 0;
  const crCount = crs.length;

  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  // The next '\n' at or after pos: -1 when there is none left, -2 when it has
  // not been looked up yet. It is only ever the first '\n' past pos, so a
  // quoted field whose close sits past it holds a line break inside. lineCR
  // says whether that line ends in CRLF; it is set whenever lineEnd is.
  let lineEnd = -2;
  let lineCR = false;
  // The record being read: the line it starts on, and the index in rows it
  // takes (null while the header is being read).
  let recordLine = 1;
  let recordRow = null;

  // Unquoted reading for the rare paths: a stray CR inside the field, the junk
  // after a closing quote, the re-read after a quote that never closes. It
  // starts at pos with `initial` already in the value and returns the value,
  // how the field ended (0 at a comma, 1 at a line break or the end of the
  // text) and how many characters it kept after `initial`.
  function readUnquotedSlow(initial) {
    let value = initial;
    let added = 0;
    for (;;) {
      if (pos >= n) return { value, ended: 1, added };
      if (lineEnd === -2) {
        lineEnd = text.indexOf('\n', pos);
        lineCR = lineEnd !== -1 && text.charCodeAt(lineEnd - 1) === 13;
      }
      const comma = text.indexOf(',', pos);
      let endKind;
      let contentEnd;
      if (comma !== -1 && (lineEnd === -1 || comma < lineEnd)) {
        endKind = 0;
        contentEnd = comma;
      } else if (lineEnd !== -1) {
        endKind = 1;
        contentEnd = lineCR ? lineEnd - 1 : lineEnd;
      } else {
        endKind = 2;
        contentEnd = n;
      }
      while (crIdx < crCount && crs[crIdx] < pos) crIdx++;
      const cr = crIdx < crCount ? crs[crIdx] : -1;
      if (cr !== -1 && cr < contentEnd) {
        if (cr > pos) {
          value += text.slice(pos, cr);
          added += cr - pos;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos = cr + 1;
        continue;
      }
      if (contentEnd > pos) {
        value += text.slice(pos, contentEnd);
        added += contentEnd - pos;
      }
      if (endKind === 0) {
        pos = comma + 1;
        return { value, ended: 0, added };
      }
      if (endKind === 1) {
        pos = lineEnd + 1;
        line++;
        return { value, ended: 1, added };
      }
      pos = n;
      return { value, ended: 1, added };
    }
  }

  while (true) {
    // A line left with no characters is no record.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    // A new record: the cached line end is stale, look it up again on first use.
    lineEnd = -2;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = 1;
    let lastQuoted = false;

    for (;;) {
      let value;
      if (pos >= n) {
        // The text ended on a comma: one last empty field.
        value = '';
        ended = 1;
        lastQuoted = false;
      } else if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        lastQuoted = true;
        const open = pos;
        let q = text.indexOf('"', pos + 1);
        let doubled = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          doubled = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          const r = readUnquotedSlow('"');
          value = r.value;
          ended = r.ended;
        } else {
          if (lineEnd === -2) {
            lineEnd = text.indexOf('\n', pos);
            lineCR = lineEnd !== -1 && text.charCodeAt(lineEnd - 1) === 13;
          }
          const hasNL = lineEnd !== -1 && q > lineEnd;
          while (crIdx < crCount && crs[crIdx] < pos + 1) crIdx++;
          const hasCR = crIdx < crCount && crs[crIdx] < q;
          if (!doubled && !hasNL && !hasCR) {
            value = text.slice(pos + 1, q);
          } else if (doubled && !hasNL && !hasCR) {
            value = text.slice(pos + 1, q).replaceAll('""', '"');
          } else {
            // The quoted field holds line breaks or lone CRs: read it by runs,
            // each CRLF or lone CR inside it one LF.
            let v = '';
            let i = pos + 1;
            let runStart = i;
            while (i < q) {
              const c = text.charCodeAt(i);
              if (c === 34) {
                if (i > runStart) v += text.slice(runStart, i);
                v += '"';
                i += text.charCodeAt(i + 1) === 34 ? 2 : 1;
                runStart = i;
              } else if (c === 13) {
                if (i > runStart) v += text.slice(runStart, i);
                v += '\n';
                line++;
                i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
                runStart = i;
              } else if (c === 10) {
                if (i > runStart) v += text.slice(runStart, i);
                v += '\n';
                line++;
                i++;
                runStart = i;
              } else {
                i++;
              }
            }
            if (q > runStart) v += text.slice(runStart, q);
            value = v;
          }
          // The field spanned a line break: the cached line end is stale.
          if (hasNL) lineEnd = -2;
          pos = q + 1;
          if (pos >= n) {
            ended = 1;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos++;
              ended = 0;
            } else if (c === 10) {
              pos++;
              line++;
              ended = 1;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line++;
              ended = 1;
            } else {
              // What follows the closing quote is appended as it stands.
              const r = readUnquotedSlow(value);
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              value = r.value;
              ended = r.ended;
            }
          }
        }
      } else {
        // An unquoted field.
        lastQuoted = false;
        if (lineEnd === -2) {
          lineEnd = text.indexOf('\n', pos);
          lineCR = lineEnd !== -1 && text.charCodeAt(lineEnd - 1) === 13;
        }
        const comma = text.indexOf(',', pos);
        let contentEnd;
        let endKind;
        if (comma !== -1 && (lineEnd === -1 || comma < lineEnd)) {
          contentEnd = comma;
          endKind = 0;
        } else if (lineEnd !== -1) {
          contentEnd = lineCR ? lineEnd - 1 : lineEnd;
          endKind = 1;
        } else {
          contentEnd = n;
          endKind = 2;
        }
        while (crIdx < crCount && crs[crIdx] < pos) crIdx++;
        const cr = crIdx < crCount ? crs[crIdx] : -1;
        if (cr !== -1 && cr < contentEnd) {
          const r = readUnquotedSlow('');
          value = r.value;
          ended = r.ended;
        } else {
          value = text.slice(pos, contentEnd);
          if (endKind === 0) {
            pos = comma + 1;
            ended = 0;
          } else if (endKind === 1) {
            pos = lineEnd + 1;
            line++;
            ended = 1;
          } else {
            pos = n;
            ended = 1;
          }
        }
      }
      fields.push(value);
      if (ended !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
