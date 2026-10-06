use crate::decode::scanner::{LineKind, ParsedLine, scan};

#[cfg(not(feature = "std"))]
use alloc::{
    borrow::ToOwned,
    collections::BTreeSet,
    format,
    string::{String, ToString},
    vec::Vec,
};

#[cfg(feature = "std")]
use std::collections::BTreeSet;

use crate::number::has_forbidden_leading_zeros;
use crate::value::{Number, Value};

pub struct Parser<'a> {
    lines: Vec<ParsedLine<'a>>,
    idx: usize,
    strict: bool,
    indent_size: usize,
    mark_quoted_dots: bool,
    error: Option<crate::error::Error>,
}

impl<'a> Parser<'a> {
    pub fn from_input(input: &'a str) -> Self {
        Self {
            lines: scan(input),
            idx: 0,
            strict: false,
            indent_size: 2,
            mark_quoted_dots: true,
            error: None,
        }
    }

    pub fn from_input_with_strict(input: &'a str, strict: bool) -> Self {
        Self {
            lines: scan(input),
            idx: 0,
            strict,
            indent_size: 2,
            mark_quoted_dots: true,
            error: None,
        }
    }

    pub fn from_lines(lines: Vec<ParsedLine<'a>>, strict: bool) -> Self {
        Self {
            lines,
            idx: 0,
            strict,
            indent_size: 2,
            mark_quoted_dots: true,
            error: None,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    fn skip_blanks(&mut self) {
        while let Some(line) = self.lines.get(self.idx) {
            if matches!(line.kind, LineKind::Blank) {
                self.idx += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<&ParsedLine<'a>> {
        self.lines.get(self.idx)
    }

    fn next(&mut self) -> Option<&ParsedLine<'a>> {
        let i = self.idx;
        self.idx += 1;
        self.lines.get(i)
    }

    fn parse_scalar_token(&mut self, s: &str) -> Value {
        self.parse_scalar_token_at_line(s, self.idx)
    }

    fn parse_scalar_token_at_line(&mut self, s: &str, line_no: usize) -> Value {
        if s == "[]" {
            return Value::Array(Vec::new());
        }
        if s.starts_with('"') {
            match try_unescape_json_string(s) {
                Ok(st) => return Value::String(st),
                Err(e) if self.error.is_none() => {
                    self.error = Some(crate::error::Error::Syntax {
                        line: line_no,
                        message: match e {
                            StringParseError::Unterminated => "unterminated string".to_string(),
                            StringParseError::InvalidEscape => {
                                "invalid escape sequence".to_string()
                            }
                        },
                    });
                    // Return an empty string as a fallback
                    return Value::String(String::new());
                }
                Err(_) => return Value::String(String::new()),
            }
        }
        if has_forbidden_leading_zeros(s) {
            return Value::String(s.to_string());
        }
        match s {
            "true" => return Value::Bool(true),
            "false" => return Value::Bool(false),
            "null" => return Value::Null,
            _ => {}
        }
        // Fast path for pure integers (ASCII digits, optional leading '-')
        let bs = s.as_bytes();
        if !bs.is_empty() {
            if bs[0] == b'-' {
                if bs.len() > 1
                    && bs[1..].iter().all(|c| c.is_ascii_digit())
                    && let Ok(i) = s.parse::<i64>()
                {
                    return Value::Number(Number::I64(i));
                }
            } else if bs.iter().all(|c| c.is_ascii_digit())
                && let Ok(u) = s.parse::<u64>()
            {
                return Value::Number(Number::U64(u));
            }
        }
        match classify_numeric_hint(s) {
            Some(NumHint::Float) => {
                if let Ok(f) = s.parse::<f64>() {
                    // Normalize integer-valued floats to integers
                    // Use f % 1.0 instead of f.fract() for no_std compatibility
                    if f.is_finite() && f % 1.0 == 0.0 {
                        // The upper u64 bound rounds to 2^64 in f64, so it must
                        // be exclusive. Saturating casts would silently change
                        // larger exponent-form values.
                        if f >= 0.0 && f < u64::MAX as f64 {
                            return Value::Number(Number::U64(f as u64));
                        } else if f < 0.0 && f >= i64::MIN as f64 {
                            return Value::Number(Number::I64(f as i64));
                        }
                    }
                    return Value::Number(Number::F64(f));
                }
            }
            Some(NumHint::IntSigned) => {
                if let Ok(i) = s.parse::<i64>() {
                    return Value::Number(Number::I64(i));
                }
                if let Ok(f) = s.parse::<f64>() {
                    return Value::Number(Number::F64(f));
                }
            }
            Some(NumHint::IntUnsigned) => {
                if let Ok(u) = s.parse::<u64>() {
                    return Value::Number(Number::U64(u));
                }
                if let Ok(f) = s.parse::<f64>() {
                    return Value::Number(Number::F64(f));
                }
            }
            None => {}
        }
        Value::String(s.to_string())
    }

    fn parse_key_token(&mut self, k: &str) -> String {
        self.parse_key_token_at_line(k, self.idx)
    }

    fn parse_key_token_at_line(&mut self, k: &str, line_no: usize) -> String {
        if k.starts_with('"') {
            match try_unescape_json_string(k) {
                Ok(st) => {
                    // If this quoted key contains a dot, mark it to prevent path expansion
                    // by prefixing with a zero-width space (U+200B)
                    if self.mark_quoted_dots && st.contains('.') {
                        let mut marked = String::with_capacity(st.len() + 3);
                        marked.push('\u{200B}');
                        marked.push_str(&st);
                        return marked;
                    }
                    return st;
                }
                Err(e) if self.error.is_none() => {
                    self.error = Some(crate::error::Error::Syntax {
                        line: line_no,
                        message: match e {
                            StringParseError::Unterminated => "unterminated string".to_string(),
                            StringParseError::InvalidEscape => {
                                "invalid escape sequence".to_string()
                            }
                        },
                    });
                    return String::new();
                }
                Err(_) => return String::new(),
            }
        }
        k.to_string()
    }

    fn parse_array(&mut self, indent: usize) -> Value {
        let mut arr = Vec::new();
        let mut inside_array = false;
        loop {
            // In strict mode, error on blank lines inside arrays (only if next non-blank is still part of this array)
            if self.strict
                && inside_array
                && let Some(bl) = self.peek()
                && matches!(bl.kind, LineKind::Blank)
            {
                // Look ahead past blanks to see if next content is still at this array's indent
                let saved_idx = self.idx;
                self.skip_blanks();
                let is_inside = self.peek().is_some_and(|next| {
                    next.indent == indent && matches!(next.kind, LineKind::ListItem { .. })
                });
                self.idx = saved_idx; // Restore position
                if is_inside {
                    let line_no = self.idx + 1;
                    self.error = Some(crate::error::Error::Syntax {
                        line: line_no,
                        message: "blank line inside array".to_string(),
                    });
                }
            }
            self.skip_blanks();
            let (take, item_val): (bool, Option<&str>) = if let Some(line) = self.peek() {
                if line.indent != indent {
                    break;
                }
                match &line.kind {
                    LineKind::ListItem { value } => (true, *value),
                    _ => (false, None),
                }
            } else {
                break;
            };
            if !take {
                break;
            }
            inside_array = true;
            self.next();
            if let Some(vs) = item_val {
                // 1) Support array headers embedded in list item values, e.g. "- [N]:" or "- [N]{fields}: ..."
                if let Some(header) = parse_list_array_header(vs) {
                    // If header has a key, this is a keyed array as first field of list-item object
                    if let Some(ref key) = header.key {
                        let key_parsed = self.parse_key_token(key);
                        let child_indent = indent + self.indent_size;
                        let mut map: Vec<(String, Value)> = Vec::new();
                        let v = self.parse_keyed_array_value(&header);
                        map.push((key_parsed, v));
                        // Parse any additional fields at child indent
                        if let Value::Object(mut rest) = self.parse_object(child_indent) {
                            map.append(&mut rest);
                        }
                        arr.push(Value::Object(map));
                        continue;
                    }
                    // No key - this is an inline array like "- [N]{fields}:"
                    if let Some(ref fields) = header.fields {
                        if self.strict && self.error.is_none() {
                            self.error = Some(crate::error::Error::Syntax {
                                line: self.idx,
                                message: "keyless tabular header is not valid as a list item"
                                    .into(),
                            });
                        }
                        let header_line_no = self.idx; // Already consumed the header
                        let row_indent = self
                            .next_content_indent()
                            .unwrap_or(indent + self.indent_size);
                        let fields_refs: Vec<&str> = fields.iter().map(|s| s.as_str()).collect();
                        arr.push(self.parse_tabular_rows(
                            header.length,
                            header.delimiter,
                            &fields_refs,
                            row_indent,
                            header_line_no,
                        ));
                        continue;
                    }
                    if let Some(ref inline) = header.inline_values
                        && !inline.is_empty()
                    {
                        let values = split_delim_aware(inline, header.delimiter);
                        if self.strict && values.len() != header.length && self.error.is_none() {
                            self.error = Some(crate::error::Error::Syntax {
                                line: self.idx,
                                message: format!(
                                    "array length mismatch: header declares {} elements but found {}",
                                    header.length,
                                    values.len()
                                ),
                            });
                        }
                        arr.push(Value::Array(
                            values
                                .into_iter()
                                .map(|v| self.parse_scalar_token(v))
                                .collect(),
                        ));
                        continue;
                    }
                    // Empty array: [0]: produces []
                    if header.length == 0 {
                        arr.push(Value::Array(Vec::new()));
                        continue;
                    }
                    // Expanded array header: parse nested list items at child indent
                    let child_indent = self
                        .peek()
                        .map(|l| l.indent)
                        .unwrap_or(indent + self.indent_size);
                    arr.push(self.parse_array(child_indent));
                    continue;
                }
                // 2) Support object-as-list-item with first field on the hyphen line: "- key: value"
                if let Some((kraw, vraw)) = split_kv_quote_aware(vs) {
                    let key = self.parse_key_token(kraw);
                    let child_indent = indent + self.indent_size;
                    let mut map: Vec<(String, Value)> = Vec::new();
                    if vraw.is_empty() {
                        // Value on following indented lines
                        let v = self.parse_node(child_indent);
                        map.push((key, v));
                    } else {
                        map.push((key, self.parse_scalar_token(vraw)));
                    }
                    // Parse any additional fields at child indent and merge
                    if let Value::Object(mut rest) = self.parse_object(child_indent) {
                        map.append(&mut rest);
                    }
                    arr.push(Value::Object(map));
                    continue;
                }
                // 3) Fallback: treat as scalar list item
                arr.push(self.parse_scalar_token(vs));
            } else {
                // Bare "-" list item - check if there are children
                let child_indent = indent + self.indent_size;
                let child_val = self.parse_node(child_indent);
                // If parse_node returns Null (no children), this is an empty object
                if matches!(child_val, Value::Null) {
                    arr.push(Value::Object(Vec::new()));
                } else {
                    arr.push(child_val);
                }
            }
        }
        Value::Array(arr)
    }

    fn parse_object(&mut self, indent: usize) -> Value {
        let mut map: Vec<(String, Value)> = Vec::new();
        let has_inline_list_field = self.idx > 0
            && self.lines.get(self.idx - 1).is_some_and(|line| {
                matches!(line.kind, LineKind::ListItem { value: Some(_) })
                    && line.indent + self.indent_size == indent
            });
        loop {
            if self.strict
                && has_inline_list_field
                && self
                    .peek()
                    .is_some_and(|line| matches!(line.kind, LineKind::Blank))
            {
                let saved = self.idx;
                self.skip_blanks();
                if self.peek().is_some_and(|line| line.indent == indent) {
                    self.error.get_or_insert(crate::error::Error::Syntax {
                        line: saved + 1,
                        message: "blank line inside object scope".into(),
                    });
                }
                self.idx = saved;
            }
            self.skip_blanks();
            // Support scalar keyed-array header lines like "key[N] v1,v2" by synthesizing a header
            if let Some(line) = self.peek()
                && line.indent == indent
                && let LineKind::Scalar(s) = &line.kind
                && is_array_header_line(s)
                && s.contains('[')
                && let Some(header) = parse_scalar_keyed_array_header(s)
                && header.key.is_some()
            {
                self.next();
                let k = header
                    .key
                    .as_ref()
                    .map(|k| self.parse_key_token(k))
                    .unwrap_or_default();
                let v = self.parse_keyed_array_value(&header);
                map.push((k, v));
                continue;
            }

            let next_kind = if let Some(line) = self.peek() {
                if line.indent != indent {
                    break;
                }
                match &line.kind {
                    LineKind::KeyValue { key, value } => Some((Some(*key), Some(*value))),
                    LineKind::KeyOnly { key } => Some((Some(*key), None)),
                    _ => None,
                }
            } else {
                break;
            };
            let Some((key_opt, val_opt)) = next_kind else {
                break;
            };
            match (key_opt, val_opt) {
                (Some(kref), Some(vref)) => {
                    if let Some(mut header) = parse_array_header(vref)
                        && header.key.is_none()
                    {
                        header.key = Some(kref.to_string());
                        self.next();
                        let value = self.parse_keyed_array_value(&header);
                        map.push((self.parse_key_token(kref), value));
                        continue;
                    }
                    // Check if this is a keyed array header like "key[3]: 1,2,3"
                    let combined = format!("{}: {}", kref, vref);
                    if self.strict && parse_array_header(&combined).is_some_and(|h| h.key.is_none())
                    {
                        self.error.get_or_insert(crate::error::Error::Syntax {
                            line: self.idx + 1,
                            message: "keyless array header is only valid at the document root or as a list item".into(),
                        });
                    }
                    if let Some(header) = parse_array_header(&combined).filter(|h| {
                        array_header_matches_key(h, kref) && !h.fields_delimiter_mismatch
                    }) {
                        self.next();
                        let k = header
                            .key
                            .as_ref()
                            .map(|k| self.parse_key_token(k))
                            .unwrap_or_default();
                        let v = self.parse_keyed_array_value(&header);
                        map.push((k, v));
                        continue;
                    }

                    self.next();
                    let k = self.parse_key_token(kref);
                    let v = self.parse_scalar_token(vref);
                    map.push((k, v));
                }
                (Some(kref), None) => {
                    // Check if this is an array header like "key[3]:" or "key[2]{id,name}:"
                    if let Some(header) = parse_array_header(&format!("{}:", kref)) {
                        if self.strict && header.key.is_none() {
                            self.error.get_or_insert(crate::error::Error::Syntax {
                                line: self.idx + 1,
                                message: "keyless array header is only valid at the document root or as a list item".into(),
                            });
                            self.next();
                            continue;
                        }
                        self.next();
                        let k = header
                            .key
                            .as_ref()
                            .map(|k| self.parse_key_token(k))
                            .unwrap_or_default();
                        let v = self.parse_keyed_array_value(&header);
                        map.push((k, v));
                        continue;
                    }
                    self.next();
                    let k = self.parse_key_token(kref);
                    // Detect actual child indent from next line (supports non-multiple indentation in non-strict mode)
                    let child_indent = self
                        .peek()
                        .map(|l| l.indent)
                        .unwrap_or(indent + self.indent_size);
                    let mut handled = false;
                    if let Some(nl) = self.peek()
                        && nl.indent == child_indent
                        && nl.indent > indent
                        && let LineKind::Scalar(s0) = &nl.kind
                    {
                        let header_text = *s0;
                        if let Some((dch, header_str)) = parse_header(header_text) {
                            if self.strict && !(dch == ',' || dch == '\t' || dch == '|') {
                                let line_no = self.idx + 1;
                                self.error = Some(crate::error::Error::Syntax {
                                    line: line_no,
                                    message: format!(
                                        "invalid header delimiter '{}': expected ',', '\\t', or '|'",
                                        dch
                                    ),
                                });
                            }
                            self.next();
                            let raw_header_tokens = split_delim_aware(header_str, dch);
                            let header_keys = raw_header_tokens
                                .iter()
                                .map(|h| self.parse_key_token(h))
                                .collect::<Vec<_>>();
                            if self.strict {
                                if header_keys.is_empty() {
                                    let line_no = self.idx;
                                    self.error = Some(crate::error::Error::Syntax {
                                        line: line_no,
                                        message: "empty tabular header".to_string(),
                                    });
                                }
                                for &htok in raw_header_tokens.iter() {
                                    if !is_quoted_token(htok) && token_requires_quotes(htok, dch) {
                                        let line_no = self.idx;
                                        self.error = Some(crate::error::Error::Syntax {
                                            line: line_no,
                                            message: format!(
                                                "unquoted header token requires quotes: {}",
                                                htok
                                            ),
                                        });
                                        break;
                                    }
                                }
                                for i in 0..header_keys.len() {
                                    for j in (i + 1)..header_keys.len() {
                                        if header_keys[i] == header_keys[j] {
                                            let line_no = self.idx;
                                            self.error = Some(crate::error::Error::Syntax {
                                                line: line_no,
                                                message: format!(
                                                    "duplicate header key: {}",
                                                    header_keys[i]
                                                ),
                                            });
                                            break;
                                        }
                                    }
                                }
                            }
                            let expected_cells = header_keys.len();
                            let mut rows: Vec<Value> = Vec::new();
                            loop {
                                if self.strict
                                    && let Some(bl) = self.peek()
                                    && matches!(bl.kind, LineKind::Blank)
                                {
                                    let line_no = self.idx + 1;
                                    self.error = Some(crate::error::Error::Syntax {
                                        line: line_no,
                                        message: "blank line inside table".to_string(),
                                    });
                                }
                                self.skip_blanks();
                                let row_item: Option<&str> = if let Some(rowl) = self.peek() {
                                    if rowl.indent != child_indent {
                                        break;
                                    }
                                    match &rowl.kind {
                                        LineKind::ListItem { value: Some(rs) } => Some(*rs),
                                        _ => None,
                                    }
                                } else {
                                    break;
                                };
                                let Some(rs) = row_item else {
                                    break;
                                };
                                let row_line = self.idx + 1;
                                self.next();
                                let row_trimmed = rs.trim_end();
                                if self.strict
                                    && row_trimmed.as_bytes().last().copied() == Some(dch as u8)
                                {
                                    self.error = Some(crate::error::Error::Syntax {
                                        line: row_line,
                                        message: "trailing delimiter in row".to_string(),
                                    });
                                }
                                let cells = split_delim_aware(rs, dch);
                                if self.strict
                                    && self.error.is_none()
                                    && cells.len() != expected_cells
                                {
                                    self.error = Some(crate::error::Error::Syntax {
                                        line: row_line,
                                        message: format!(
                                            "row cell count {} does not match header {}",
                                            cells.len(),
                                            expected_cells
                                        ),
                                    });
                                }
                                if self.strict && self.error.is_none() {
                                    for ctok in &cells {
                                        if !is_quoted_token(ctok)
                                            && cell_token_requires_quotes(ctok, dch)
                                        {
                                            self.error = Some(crate::error::Error::Syntax {
                                                line: row_line,
                                                message: format!(
                                                    "unquoted cell requires quotes: {}",
                                                    ctok
                                                ),
                                            });
                                            break;
                                        }
                                    }
                                }
                                let mut om: Vec<(String, Value)> =
                                    Vec::with_capacity(expected_cells);
                                for (i, hk) in header_keys.iter().enumerate() {
                                    let cell = cells.get(i).copied().unwrap_or("null");
                                    om.push((hk.clone(), self.parse_scalar_token(cell)));
                                }
                                rows.push(Value::Object(om));
                            }
                            if self.strict && rows.is_empty() {
                                let line_no = self.idx;
                                self.error = Some(crate::error::Error::Syntax {
                                    line: line_no,
                                    message: "empty table (no rows)".to_string(),
                                });
                            }
                            map.push((k.clone(), Value::Array(rows)));
                            handled = true;
                        }
                    }
                    if !handled {
                        // Check for bare scalar after key: - this is an error
                        // (scalars in object context must have a key)
                        if let Some(nl) = self.peek()
                            && nl.indent > indent
                            && let LineKind::Scalar(s) = &nl.kind
                        {
                            // Only error if it's a plain scalar, not a header line
                            if !s.starts_with('@') && !s.starts_with('[') && self.error.is_none() {
                                self.error = Some(crate::error::Error::Syntax {
                                    line: self.idx + 1,
                                    message: "missing colon in key-value context".to_string(),
                                });
                            }
                        }
                        let v = self.parse_node(child_indent);
                        // If key: has no children, produce empty object instead of null
                        if matches!(v, Value::Null) {
                            map.push((k, Value::Object(Vec::new())));
                        } else {
                            map.push((k, v));
                        }
                    }
                }
                _ => break,
            }
        }
        Value::Object(map)
    }

    fn parse_scalar_line(&mut self, indent: usize) -> Value {
        let s_opt = match self.peek() {
            Some(pl) => match &pl.kind {
                LineKind::Scalar(s) => Some(*s),
                _ => None,
            },
            None => None,
        };

        // Check if this is a tabular array header
        if let Some(s) = s_opt
            && let Some((dch, header_str)) = parse_header(s)
        {
            // This is a tabular header, parse it as a root-level tabular array
            if self.strict && !(dch == ',' || dch == '\t' || dch == '|') {
                let line_no = self.idx + 1;
                self.error = Some(crate::error::Error::Syntax {
                    line: line_no,
                    message: format!(
                        "invalid header delimiter '{}': expected ',', '\\t', or '|'",
                        dch
                    ),
                });
            }
            self.next(); // Consume the header line

            let raw_header_tokens = split_delim_aware(header_str, dch);
            let header_keys = raw_header_tokens
                .iter()
                .map(|h| self.parse_key_token(h))
                .collect::<Vec<_>>();

            if self.strict {
                if header_keys.is_empty() {
                    let line_no = self.idx;
                    self.error = Some(crate::error::Error::Syntax {
                        line: line_no,
                        message: "empty tabular header".to_string(),
                    });
                }
                for htok in raw_header_tokens.iter() {
                    if !is_quoted_token(htok) && token_requires_quotes(htok, dch) {
                        let line_no = self.idx;
                        self.error = Some(crate::error::Error::Syntax {
                            line: line_no,
                            message: format!("unquoted header token requires quotes: {}", htok),
                        });
                        break;
                    }
                }
                for i in 0..header_keys.len() {
                    for j in (i + 1)..header_keys.len() {
                        if header_keys[i] == header_keys[j] {
                            let line_no = self.idx;
                            self.error = Some(crate::error::Error::Syntax {
                                line: line_no,
                                message: format!("duplicate header key: {}", header_keys[i]),
                            });
                            break;
                        }
                    }
                }
            }

            let expected_cells = header_keys.len();
            let mut rows: Vec<Value> = Vec::new();

            loop {
                if self.strict
                    && let Some(bl) = self.peek()
                    && matches!(bl.kind, LineKind::Blank)
                {
                    let line_no = self.idx + 1;
                    self.error = Some(crate::error::Error::Syntax {
                        line: line_no,
                        message: "blank line inside table".to_string(),
                    });
                }
                self.skip_blanks();

                let row_item: Option<&str> = if let Some(rowl) = self.peek() {
                    if rowl.indent != indent {
                        break;
                    }
                    match &rowl.kind {
                        LineKind::ListItem { value: Some(rs) } => Some(*rs),
                        _ => None,
                    }
                } else {
                    break;
                };

                let Some(rs) = row_item else {
                    break;
                };
                let row_line = self.idx + 1;
                self.next();

                let row_trimmed = rs.trim_end();
                if self.strict && row_trimmed.as_bytes().last().copied() == Some(dch as u8) {
                    self.error = Some(crate::error::Error::Syntax {
                        line: row_line,
                        message: "trailing delimiter in row".to_string(),
                    });
                }

                let cells = split_delim_aware(rs, dch);
                if self.strict && self.error.is_none() && cells.len() != expected_cells {
                    self.error = Some(crate::error::Error::Syntax {
                        line: row_line,
                        message: format!(
                            "row cell count {} does not match header {}",
                            cells.len(),
                            expected_cells
                        ),
                    });
                }
                if self.strict && self.error.is_none() {
                    for ctok in &cells {
                        if !is_quoted_token(ctok) && cell_token_requires_quotes(ctok, dch) {
                            self.error = Some(crate::error::Error::Syntax {
                                line: row_line,
                                message: format!("unquoted cell requires quotes: {}", ctok),
                            });
                            break;
                        }
                    }
                }

                let mut om: Vec<(String, Value)> = Vec::with_capacity(expected_cells);
                for (i, hk) in header_keys.iter().enumerate() {
                    let cell = cells.get(i).copied().unwrap_or("null");
                    om.push((hk.clone(), self.parse_scalar_token(cell)));
                }
                rows.push(Value::Object(om));
            }

            if self.strict && rows.is_empty() {
                let line_no = self.idx;
                self.error = Some(crate::error::Error::Syntax {
                    line: line_no,
                    message: "empty table (no rows)".to_string(),
                });
            }

            return Value::Array(rows);
        }

        // Not a tabular header, parse as regular scalar
        self.next();
        if let Some(s) = s_opt {
            return self.parse_scalar_token(s);
        }
        Value::Null
    }

    fn parse_node(&mut self, min_indent: usize) -> Value {
        self.skip_blanks();
        let Some(line) = self.peek() else {
            return Value::Null;
        };

        // Use actual line indent if it's at or past the minimum (supports non-multiple indentation)
        // Return Null if line is at lower indent than expected
        if line.indent < min_indent {
            return Value::Null;
        }
        let indent = line.indent;

        // Check for array headers at this indent level
        {
            match &line.kind {
                LineKind::KeyOnly { key } => {
                    // Check for empty collections
                    if *key == "[0]" {
                        self.next();
                        return Value::Array(Vec::new());
                    }
                    if *key == "{0}" {
                        self.next();
                        return Value::Object(Vec::new());
                    }

                    // Check for array headers like [N]: or [N]{fields}:
                    if key.starts_with('[') {
                        let with_colon = format!("{}:", key);
                        if let Some(header) = parse_array_header(&with_colon) {
                            if self.strict && indent > 0 && header.key.is_none() {
                                self.error.get_or_insert(crate::error::Error::Syntax {
                                    line: self.idx + 1,
                                    message: "keyless array header is only valid at the document root or as a list item".into(),
                                });
                                self.next();
                                return Value::Null;
                            }
                            // This is a root-level array at this indent
                            if header.key.is_none() {
                                let header_line_no = self.idx + 1;
                                self.next();
                                if let Some(ref fields) = header.fields {
                                    let fields_refs: Vec<&str> =
                                        fields.iter().map(|s| s.as_str()).collect();
                                    return self.parse_tabular_rows(
                                        header.length,
                                        header.delimiter,
                                        &fields_refs,
                                        indent + self.indent_size,
                                        header_line_no,
                                    );
                                }
                                if let Some(ref inline) = header.inline_values
                                    && !inline.is_empty()
                                {
                                    let values = split_delim_aware(inline, header.delimiter);
                                    return Value::Array(
                                        values
                                            .into_iter()
                                            .map(|v| self.parse_scalar_token(v))
                                            .collect(),
                                    );
                                }
                                return self.parse_array(indent);
                            }
                        }
                    }
                }
                LineKind::KeyValue { key, value } if key.starts_with('[') => {
                    // Check for inline root arrays like [N]: v1,v2
                    let combined = format!("{}: {}", key, value);
                    if let Some(header) = parse_array_header(&combined) {
                        if self.strict && indent > 0 && header.key.is_none() {
                            self.error.get_or_insert(crate::error::Error::Syntax {
                                line: self.idx + 1,
                                message: "keyless array header is only valid at the document root or as a list item".into(),
                            });
                            self.next();
                            return Value::Null;
                        }
                        if header.key.is_none() {
                            self.next();
                            if let Some(ref inline) = header.inline_values
                                && !inline.is_empty()
                            {
                                let values = split_delim_aware(inline, header.delimiter);
                                return Value::Array(
                                    values
                                        .into_iter()
                                        .map(|v| self.parse_scalar_token(v))
                                        .collect(),
                                );
                            }
                            return Value::Array(Vec::new());
                        }
                    }
                }
                _ => {}
            }
        }

        match &line.kind {
            LineKind::ListItem { .. } => self.parse_array(indent),
            LineKind::KeyValue { .. } | LineKind::KeyOnly { .. } => self.parse_object(indent),
            LineKind::Scalar(_) => self.parse_scalar_line(indent),
            _ => Value::Null,
        }
    }

    pub fn parse_document(&mut self) -> Value {
        self.skip_blanks();
        if self.peek().is_none() {
            // Empty document represents an empty object (root documents are implicitly objects)
            return Value::Object(Vec::new());
        }

        // Check for root-level array headers: [N]:, [N]{fields}:, etc.
        if let Some(line) = self.peek()
            && line.indent == 0
        {
            match &line.kind {
                LineKind::KeyOnly { key } => {
                    // Check for empty object {0}:
                    if *key == "{0}" {
                        self.next();
                        return Value::Object(Vec::new());
                    }

                    // Try to parse as root array header (only when keyless)
                    if is_array_header_line(key) || key.starts_with('[') {
                        let with_colon = format!("{}:", key);
                        if let Some(header) = parse_array_header(&with_colon)
                            && header.key.is_none()
                        {
                            return self.parse_root_array_with_header(header);
                        }
                    }
                }
                LineKind::KeyValue { key, value } => {
                    // Handle inline root arrays like "[N]: v1,v2" (only when keyless)
                    let combined = format!("{}: {}", key, value);
                    if (is_array_header_line(&combined) || key.starts_with('['))
                        && let Some(header) = parse_array_header(&combined)
                        && header.key.is_none()
                    {
                        return self.parse_root_array_with_header(header);
                    }
                }
                LineKind::Scalar(s) if is_array_header_line(s) || s.starts_with('[') => {
                    // Scalar might be a complete header with inline values
                    if let Some(header) = parse_array_header(s) {
                        return self.parse_root_array_with_header(header);
                    }
                }
                _ => {}
            }
        }

        let starts_root_array = self.peek().is_some_and(|line| match &line.kind {
            LineKind::KeyOnly { key } => {
                parse_array_header(&format!("{key}:")).is_some_and(|h| h.key.is_none())
            }
            LineKind::KeyValue { key, value } => {
                parse_array_header(&format!("{key}: {value}")).is_some_and(|h| h.key.is_none())
            }
            LineKind::Scalar(s) => {
                s == &"[]" || parse_array_header(s).is_some_and(|h| h.key.is_none())
            }
            _ => false,
        });
        let indent = self.peek().unwrap().indent;
        let result = self.parse_node(indent);

        if self.strict && self.error.is_none() {
            validate_duplicate_keys(&result, &mut self.error);
            self.skip_blanks();
            if self.peek().is_some() {
                self.error = Some(crate::error::Error::Syntax {
                    line: self.idx + 1,
                    message: if starts_root_array || matches!(result, Value::Array(_)) {
                        "trailing content after root array".into()
                    } else {
                        "trailing content after document root".into()
                    },
                });
            }
        }

        // In strict mode, check for multiple root-level scalars
        if self.strict && self.error.is_none() {
            self.skip_blanks();
            if let Some(next_line) = self.peek()
                && next_line.indent == indent
                && let LineKind::Scalar(_) = &next_line.kind
            {
                // Two scalars at root level in strict mode is an error
                self.error = Some(crate::error::Error::Syntax {
                    line: self.idx + 1,
                    message: "two primitives at root depth in strict mode".to_string(),
                });
            }
        }

        result
    }

    fn parse_root_array_with_header(&mut self, header: ArrayHeader) -> Value {
        let value = self.parse_root_array_inner(header);
        if self.strict && self.error.is_none() {
            self.skip_blanks();
            if self.peek().is_some() {
                self.error = Some(crate::error::Error::Syntax {
                    line: self.idx + 1,
                    message: "trailing content after root array".into(),
                });
            }
        }
        value
    }

    fn parse_root_array_inner(&mut self, header: ArrayHeader) -> Value {
        let line_no = self.idx + 1;
        self.next(); // Consume header line

        if let Some(ref fields) = header.fields {
            if header.keyed {
                let refs: Vec<&str> = fields.iter().map(String::as_str).collect();
                return self.parse_keyed_rows(
                    header.length,
                    header.delimiter,
                    &refs,
                    self.indent_size,
                    line_no,
                );
            }
            // Tabular array - rows one indentation level below the root
            let fields_refs: Vec<&str> = fields.iter().map(|s| s.as_str()).collect();
            return self.parse_tabular_rows(
                header.length,
                header.delimiter,
                &fields_refs,
                self.indent_size,
                line_no,
            );
        }

        if let Some(ref inline) = header.inline_values
            && !inline.is_empty()
        {
            // Inline primitive array
            let values = split_delim_aware(inline, header.delimiter);
            // Validate array length
            if self.strict && values.len() != header.length {
                self.error = Some(crate::error::Error::Syntax {
                    line: line_no,
                    message: format!(
                        "array length mismatch: header declares {} elements but found {}",
                        header.length,
                        values.len()
                    ),
                });
            }
            return Value::Array(
                values
                    .into_iter()
                    .map(|v| self.parse_scalar_token(v))
                    .collect(),
            );
        }

        // Expanded array with list items one indentation level below the root
        self.parse_array_with_length_check(self.indent_size, header.length, line_no)
    }

    /// Parse the value for a keyed array header
    fn parse_keyed_array_value(&mut self, header: &ArrayHeader) -> Value {
        let header_line_no = self.idx; // Header was already consumed

        // In strict mode, check for delimiter mismatch between bracket and brace
        if self.strict && header.fields_delimiter_mismatch && self.error.is_none() {
            self.error = Some(crate::error::Error::Syntax {
                line: header_line_no,
                message: "mismatched delimiter between bracket and brace fields".to_string(),
            });
        }

        if header.keyed {
            let refs: Vec<&str> = header
                .fields
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(String::as_str)
                .collect();
            if header.fields.is_none() && self.strict && self.error.is_none() {
                self.error = Some(crate::error::Error::Syntax {
                    line: header_line_no,
                    message: "keyed array requires a field list".to_string(),
                });
            }
            let row_indent = self.next_content_indent().unwrap_or(self.indent_size);
            return self.parse_keyed_rows(
                header.length,
                header.delimiter,
                &refs,
                row_indent,
                header_line_no,
            );
        }

        // If there are fields, it's a tabular array
        if let Some(ref fields) = header.fields {
            // Get current indent to determine row indent
            let row_indent = self.next_content_indent().unwrap_or(self.indent_size);
            let fields_refs: Vec<&str> = fields.iter().map(|s| s.as_str()).collect();
            return self.parse_tabular_rows(
                header.length,
                header.delimiter,
                &fields_refs,
                row_indent,
                header_line_no,
            );
        }

        // If there are inline values, parse them
        if let Some(ref inline) = header.inline_values
            && !inline.is_empty()
        {
            let values = split_delim_aware(inline, header.delimiter);
            // Validate array length
            if self.strict && values.len() != header.length && self.error.is_none() {
                self.error = Some(crate::error::Error::Syntax {
                    line: header_line_no,
                    message: format!(
                        "array length mismatch: header declares {} elements but found {}",
                        header.length,
                        values.len()
                    ),
                });
            }
            return Value::Array(
                values
                    .into_iter()
                    .map(|v| self.parse_scalar_token(v))
                    .collect(),
            );
        }

        // Otherwise, parse list items at child indent
        let child_indent = self.next_content_indent().unwrap_or(self.indent_size);
        self.parse_array_with_length_check(child_indent, header.length, header_line_no)
    }

    /// Parse tabular rows at the given indent level
    fn parse_tabular_rows(
        &mut self,
        expected_count: usize,
        delimiter: char,
        fields: &[&str],
        row_indent: usize,
        header_line_no: usize,
    ) -> Value {
        let mut field_paths = Vec::new();
        for field in fields {
            self.flatten_field(
                field,
                delimiter,
                &mut Vec::new(),
                &mut field_paths,
                0,
                header_line_no,
            );
        }
        let expected_cells = field_paths.len();
        let mut unique = BTreeSet::new();
        for path in &field_paths {
            if !unique.insert(path.clone()) && self.strict && self.error.is_none() {
                self.error = Some(crate::error::Error::Syntax {
                    line: header_line_no,
                    message: "duplicate field name".into(),
                });
            }
        }

        let mut rows: Vec<Value> = Vec::new();
        let mut inside_table = false;

        loop {
            // In strict mode, error on blank lines inside tabular arrays
            if self.strict
                && inside_table
                && let Some(bl) = self.peek()
                && matches!(bl.kind, LineKind::Blank)
            {
                // Look ahead to see if next content is still part of this table
                let saved_idx = self.idx;
                self.skip_blanks();
                let is_inside = self.peek().is_some_and(|next| {
                    (next.indent == row_indent && matches!(next.kind, LineKind::Scalar(_)))
                        || (next.indent > 0 && matches!(next.kind, LineKind::ListItem { .. }))
                });
                self.idx = saved_idx;
                if is_inside {
                    let line_no = self.idx + 1;
                    self.error = Some(crate::error::Error::Syntax {
                        line: line_no,
                        message: "blank line inside table".to_string(),
                    });
                }
            }
            self.skip_blanks();

            let Some(line) = self.peek() else {
                break;
            };

            // Rows must be at the expected indent level
            if line.indent != row_indent {
                break;
            }

            // Row line should be a scalar (raw delimited values)
            let row_text = match &line.kind {
                LineKind::Scalar(s) => *s,
                LineKind::KeyValue { .. } => {
                    // Could be a key:value line that signals end of rows
                    break;
                }
                LineKind::KeyOnly { .. } | LineKind::ListItem { .. } => {
                    // These indicate end of tabular rows
                    break;
                }
                LineKind::Blank => {
                    self.next();
                    continue;
                }
            };

            inside_table = true;
            let row_line_no = self.idx + 1;
            self.next();

            // In strict mode, check if row uses a different delimiter than declared
            if self.strict && self.error.is_none() && check_delimiter_mismatch(row_text, delimiter)
            {
                self.error = Some(crate::error::Error::Syntax {
                    line: row_line_no,
                    message:
                        "delimiter mismatch: row uses different delimiter than header declares"
                            .to_string(),
                });
            }

            let cells = split_delim_aware(row_text, delimiter);

            // Validate cell count matches header field count
            if self.strict && cells.len() != expected_cells && self.error.is_none() {
                self.error = Some(crate::error::Error::Syntax {
                    line: row_line_no,
                    message: format!(
                        "tabular row has {} values but header declares {} fields",
                        cells.len(),
                        expected_cells
                    ),
                });
            }

            let mut om: Vec<(String, Value)> = Vec::new();
            for (i, path) in field_paths.iter().enumerate() {
                let cell = cells.get(i).copied().unwrap_or("");
                let value = if cell == "[]" {
                    Value::String(cell.to_string())
                } else {
                    self.parse_scalar_token(cell)
                };
                insert_field_path(&mut om, path, value);
            }
            rows.push(Value::Object(om));
        }

        // Validate row count matches header length
        if self.strict && rows.len() != expected_count && self.error.is_none() {
            self.error = Some(crate::error::Error::Syntax {
                line: header_line_no,
                message: format!(
                    "tabular array has {} rows but header declares {}",
                    rows.len(),
                    expected_count
                ),
            });
        }

        Value::Array(rows)
    }

    fn flatten_field(
        &mut self,
        raw: &str,
        delimiter: char,
        parents: &mut Vec<String>,
        output: &mut Vec<Vec<String>>,
        depth: usize,
        header_line_no: usize,
    ) {
        if let Some(open) = find_unquoted_open_brace(raw)
            && raw.ends_with('}')
        {
            if depth >= crate::MAX_NESTING_DEPTH {
                self.error.get_or_insert(crate::error::Error::Syntax {
                    line: header_line_no,
                    message: format!(
                        "TOON structural nesting exceeds {}",
                        crate::MAX_NESTING_DEPTH
                    ),
                });
                return;
            }
            let name = self.parse_key_token(raw[..open].trim());
            parents.push(name);
            let inner = &raw[open + 1..raw.len() - 1];
            for child in split_delim_aware(inner, delimiter) {
                self.flatten_field(child, delimiter, parents, output, depth + 1, header_line_no);
            }
            parents.pop();
            return;
        }
        let mut path = parents.clone();
        path.push(self.parse_key_token(raw));
        output.push(path);
    }

    fn next_content_indent(&self) -> Option<usize> {
        self.lines[self.idx..]
            .iter()
            .find(|line| !matches!(line.kind, LineKind::Blank))
            .map(|line| line.indent)
    }

    fn parse_keyed_rows(
        &mut self,
        expected_count: usize,
        delimiter: char,
        fields: &[&str],
        row_indent: usize,
        header_line_no: usize,
    ) -> Value {
        let mut paths = Vec::new();
        for field in fields {
            self.flatten_field(
                field,
                delimiter,
                &mut Vec::new(),
                &mut paths,
                0,
                header_line_no,
            );
        }
        let mut unique = BTreeSet::new();
        for path in &paths {
            if !unique.insert(path.clone()) && self.strict && self.error.is_none() {
                self.error = Some(crate::error::Error::Syntax {
                    line: header_line_no,
                    message: "duplicate field name".into(),
                });
            }
        }
        let mut entries: Vec<(String, Value)> = Vec::new();
        let mut seen = BTreeSet::new();
        loop {
            if self.strict
                && !entries.is_empty()
                && self
                    .peek()
                    .is_some_and(|line| matches!(line.kind, LineKind::Blank))
            {
                let blank_line = self.idx + 1;
                let saved = self.idx;
                self.skip_blanks();
                if self.peek().is_some_and(|line| line.indent == row_indent) {
                    self.error.get_or_insert(crate::error::Error::Syntax {
                        line: blank_line,
                        message: "blank line inside keyed array".into(),
                    });
                }
                self.idx = saved;
            }
            self.skip_blanks();
            let Some(line) = self.peek() else { break };
            if line.indent != row_indent {
                break;
            }
            let (raw_key, raw_cells) = match line.kind {
                LineKind::KeyValue { key, value } => (key, value),
                _ => {
                    if self.strict && self.error.is_none() {
                        self.error = Some(crate::error::Error::Syntax {
                            line: self.idx + 1,
                            message: "expected keyed entry row".into(),
                        });
                    }
                    break;
                }
            };
            let row_no = self.idx + 1;
            self.next();
            let key = self.parse_key_token(raw_key);
            if self.strict && !seen.insert(key.clone()) && self.error.is_none() {
                self.error = Some(crate::error::Error::Syntax {
                    line: row_no,
                    message: "duplicate entry key".into(),
                });
            }
            let cells = split_delim_aware(raw_cells, delimiter);
            if self.strict && cells.len() != paths.len() && self.error.is_none() {
                self.error = Some(crate::error::Error::Syntax {
                    line: row_no,
                    message: "keyed entry cell count mismatch".into(),
                });
            }
            let mut row = Vec::new();
            for (i, path) in paths.iter().enumerate() {
                let cell = cells.get(i).copied().unwrap_or("");
                let value = if cell == "[]" {
                    Value::String(cell.to_string())
                } else {
                    self.parse_scalar_token(cell)
                };
                insert_field_path(&mut row, path, value);
            }
            if let Some(existing) = entries.iter_mut().find(|(k, _)| k == &key) {
                existing.1 = Value::Object(row);
            } else {
                entries.push((key, Value::Object(row)));
            }
        }
        if self.strict && entries.len() != expected_count && self.error.is_none() {
            self.error = Some(crate::error::Error::Syntax {
                line: header_line_no,
                message: "keyed entry count mismatch".into(),
            });
        }
        Value::Object(entries)
    }

    /// Parse array with length validation
    fn parse_array_with_length_check(
        &mut self,
        indent: usize,
        expected_len: usize,
        header_line_no: usize,
    ) -> Value {
        let arr = self.parse_array(indent);
        if self
            .peek()
            .is_some_and(|line| line.indent >= indent && matches!(line.kind, LineKind::Scalar(_)))
            && self.error.is_none()
        {
            self.error = Some(crate::error::Error::Syntax {
                line: self.idx + 1,
                message: "expected a list item inside array scope".into(),
            });
        }
        if let Value::Array(ref items) = arr
            && self.strict
            && items.len() != expected_len
            && self.error.is_none()
        {
            self.error = Some(crate::error::Error::Syntax {
                line: header_line_no,
                message: format!(
                    "array length mismatch: header declares {} elements but found {}",
                    expected_len,
                    items.len()
                ),
            });
        }
        arr
    }
}

/// Legacy header parser for old @<delim> format (for backwards compatibility during transition)
fn parse_header(s: &str) -> Option<(char, &str)> {
    let mut it = s.chars();
    let at = it.next()?;
    if at != '@' {
        return None;
    }
    let dch = it.next()?;
    let rest = &s[2..];
    Some((dch, trim_ascii_start(rest)))
}

/// Parsed array header per spec v3.0
#[derive(Debug, Clone)]
pub struct ArrayHeader {
    pub key: Option<String>,             // Optional key prefix
    pub length: usize,                   // Declared length N
    pub delimiter: char,                 // Active delimiter (comma, tab, or pipe)
    pub fields: Option<Vec<String>>,     // Optional field names for tabular arrays
    pub inline_values: Option<String>,   // Optional inline values after colon
    pub fields_delimiter_mismatch: bool, // True if fields use a different delimiter than declared
    pub keyed: bool,
}

// A list-item field may use either `items[N]:` or `items: [N]:`.
fn parse_list_array_header(s: &str) -> Option<ArrayHeader> {
    if let Some((key, value)) = split_kv_quote_aware(s)
        && let Some(mut header) = parse_array_header(value)
        && header.key.is_none()
    {
        header.key = Some(key.to_string());
        return Some(header);
    }
    parse_array_header(s)
}

/// Parse a spec-compliant array header: key[N<delim?>]{fields}:[ values]
/// Returns None if not a valid array header
fn parse_array_header(s: &str) -> Option<ArrayHeader> {
    // Find the bracket that represents the array length, skipping any brackets inside quotes
    let bracket_start = find_unquoted_bracket(s)?;
    let bracket_end = find_matching_bracket(s, bracket_start)?;

    // Key is everything before the bracket (may be empty for root arrays)
    let key_part = trim_ascii(&s[..bracket_start]);
    let key = if key_part.is_empty() {
        None
    } else {
        Some(key_part.to_string())
    };

    // Parse bracket content: N or N<delim>
    let bracket_content = &s[bracket_start + 1..bracket_end];
    let (length, delimiter, keyed) = parse_bracket_content(bracket_content)?;

    // After bracket, check for fields segment and colon
    let after_bracket = &s[bracket_end + 1..];
    let (fields, fields_delimiter_mismatch, rest_after_fields) = if after_bracket.starts_with('{') {
        // Parse fields segment
        let fields_end = find_matching_brace(after_bracket, 0)?;
        let fields_content = &after_bracket[1..fields_end];

        // Check for delimiter mismatch: if the declared delimiter is tab/pipe but
        // fields contain commas (and no declared delimiter), or vice versa
        let mismatch = check_delimiter_mismatch(fields_content, delimiter);

        let field_names: Vec<String> = split_delim_aware(fields_content, delimiter)
            .into_iter()
            .map(|s| s.to_string())
            .collect();
        let rest = &after_bracket[fields_end + 1..];
        (Some(field_names), mismatch, rest)
    } else {
        (None, false, after_bracket)
    };

    // Must have a colon
    if !rest_after_fields.starts_with(':') {
        return None;
    }

    // Inline values are everything after the colon (may be empty)
    let after_colon = &rest_after_fields[1..];
    let inline_values = if after_colon.is_empty() {
        None
    } else {
        Some(trim_ascii_start(after_colon).to_string())
    };

    Some(ArrayHeader {
        key,
        length,
        delimiter,
        fields,
        inline_values,
        fields_delimiter_mismatch,
        keyed,
    })
}

fn array_header_matches_key(header: &ArrayHeader, key: &str) -> bool {
    if header.key.as_deref() == Some(key) {
        return true;
    }
    let Some(start) = find_unquoted_bracket(key) else {
        return false;
    };
    header.key.as_deref() == Some(&key[..start])
}

// Attempt to interpret a scalar line like "key[N]{fields}? values" as an array header with inline values
fn parse_scalar_keyed_array_header(s: &str) -> Option<ArrayHeader> {
    let bracket_start = find_unquoted_bracket(s)?;
    let bracket_end = find_matching_bracket(s, bracket_start)?;
    // Position after potential fields segment
    let mut pos = bracket_end + 1;
    if pos < s.len() && s.as_bytes()[pos] == b'{' {
        // fields segment present; find matching }
        let fields_end = find_matching_brace(s, pos)?;
        pos = fields_end + 1;
    }
    // Synthesize a colon after the bracket/fields segment
    let mut synthesized = String::with_capacity(s.len() + 1);
    synthesized.push_str(&s[..pos]);
    synthesized.push(':');
    synthesized.push_str(&s[pos..]);
    parse_array_header(&synthesized)
}

/// Check if a string uses a different delimiter than declared.
/// Returns true if there's evidence of using a different delimiter.
fn check_delimiter_mismatch(s: &str, declared: char) -> bool {
    // Count unquoted occurrences of each potential delimiter
    let bytes = s.as_bytes();
    let mut in_quote = false;
    let mut escape = false;
    let mut comma_count = 0usize;
    let mut tab_count = 0usize;
    let mut pipe_count = 0usize;

    for &b in bytes {
        if escape {
            escape = false;
            continue;
        }
        if in_quote {
            match b {
                b'\\' => escape = true,
                b'"' => in_quote = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_quote = true,
            b',' => comma_count += 1,
            b'\t' => tab_count += 1,
            b'|' => pipe_count += 1,
            _ => {}
        }
    }

    // If declared delimiter is comma, check if there's evidence of tab/pipe usage
    // If declared is tab/pipe, check if there's evidence of comma usage
    match declared {
        ',' => {
            // If tab or pipe appears and comma doesn't, it's a mismatch
            (tab_count > 0 || pipe_count > 0) && comma_count == 0
        }
        '\t' => {
            // If comma appears and tab doesn't, it's a mismatch
            comma_count > 0 && tab_count == 0
        }
        '|' => {
            // If comma or tab appears and pipe doesn't, it's a mismatch
            (comma_count > 0 || tab_count > 0) && pipe_count == 0
        }
        _ => false,
    }
}

fn find_unquoted_open_brace(s: &str) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    for (i, byte) in s.bytes().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b'{' {
            return Some(i);
        }
    }
    None
}

fn insert_field_path(entries: &mut Vec<(String, Value)>, path: &[String], value: Value) {
    let Some((head, tail)) = path.split_first() else {
        return;
    };
    if tail.is_empty() {
        if let Some(existing) = entries.iter_mut().find(|(key, _)| key == head) {
            existing.1 = value;
        } else {
            entries.push((head.clone(), value));
        }
        return;
    }
    let existing = entries.iter_mut().find(|(key, _)| key == head);
    if let Some((_, Value::Object(children))) = existing {
        insert_field_path(children, tail, value);
    } else if let Some((_, slot)) = existing {
        let mut children = Vec::new();
        insert_field_path(&mut children, tail, value);
        *slot = Value::Object(children);
    } else {
        let mut children = Vec::new();
        insert_field_path(&mut children, tail, value);
        entries.push((head.clone(), Value::Object(children)));
    }
}

fn validate_duplicate_keys(value: &Value, error: &mut Option<crate::error::Error>) {
    match value {
        Value::Object(entries) => {
            let mut seen = BTreeSet::new();
            for (key, child) in entries {
                if !seen.insert(key) && error.is_none() {
                    *error = Some(crate::error::Error::Syntax {
                        line: 1,
                        message: format!("duplicate sibling key: {key}"),
                    });
                }
                validate_duplicate_keys(child, error);
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_duplicate_keys(item, error);
            }
        }
        _ => {}
    }
}

/// Parse bracket content: "N" or "N<delim>" where delim is tab or pipe
fn parse_bracket_content(s: &str) -> Option<(usize, char, bool)> {
    // Only trim leading/trailing spaces, NOT tabs (tabs are delimiters)
    let s = trim_spaces_only(s);
    if s.is_empty() {
        return None;
    }

    let (number, keyed, declared_delimiter) = if let Some(colon) = s.find(':') {
        let tail = &s[colon + 1..];
        (trim_spaces_only(&s[..colon]), true, tail.chars().next())
    } else {
        (s, false, None)
    };
    let last = number.chars().last()?;
    if let Some(delimiter @ ('\t' | '|')) = declared_delimiter {
        Some((number.parse::<usize>().ok()?, delimiter, keyed))
    } else if last == '\t' || last == '|' {
        // Has explicit delimiter
        let num_part = &number[..number.len() - 1];
        let length = num_part.trim().parse::<usize>().ok()?;
        Some((length, last, keyed))
    } else {
        // No explicit delimiter means comma
        let length = number.parse::<usize>().ok()?;
        Some((length, ',', keyed))
    }
}

/// Trim only spaces, not tabs (since tabs can be delimiters)
fn trim_spaces_only(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut end = bytes.len();
    while start < end && bytes[start] == b' ' {
        start += 1;
    }
    while end > start && bytes[end - 1] == b' ' {
        end -= 1;
    }
    &s[start..end]
}

/// Find the first '[' that's not inside quotes
fn find_unquoted_bracket(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut in_quote = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        if in_quote {
            match b {
                b'\\' => escape = true,
                b'"' => in_quote = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_quote = true,
            b'[' => return Some(i),
            _ => {}
        }
    }
    None
}

/// Find the matching ] for a [ at the given position
fn find_matching_bracket(s: &str, start: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    if start >= bytes.len() || bytes[start] != b'[' {
        return None;
    }
    let mut depth = 0;
    for (i, &b) in bytes[start..].iter().enumerate() {
        match b {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(start + i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Find the matching } for a { at the given position  
fn find_matching_brace(s: &str, start: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    if start >= bytes.len() || bytes[start] != b'{' {
        return None;
    }
    let mut depth = 0;
    let mut in_quote = false;
    let mut escape = false;
    for (i, &b) in bytes[start..].iter().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        if in_quote {
            match b {
                b'\\' => escape = true,
                b'"' => in_quote = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_quote = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(start + i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Check if a line looks like an array header (has [N] pattern, not inside quotes)
fn is_array_header_line(s: &str) -> bool {
    // Find the first '[' that's not inside quotes
    let Some(bracket_start) = find_unquoted_bracket(s) else {
        return false;
    };
    let Some(bracket_end) = find_matching_bracket(s, bracket_start) else {
        return false;
    };
    let content = &s[bracket_start + 1..bracket_end];
    // Content should be digits optionally followed by delimiter
    let content = content.trim();
    if content.is_empty() {
        return false;
    }
    // Check if it starts with digits
    let first_non_digit = content.find(|c: char| !c.is_ascii_digit());
    match first_non_digit {
        None => content.parse::<usize>().is_ok(), // All digits
        Some(pos) => {
            // Must be digits followed by single delimiter char
            if pos == content.len() - 1 {
                let delim = content.chars().last().unwrap();
                return (delim == '\t' || delim == '|') && content[..pos].parse::<usize>().is_ok();
            }
            false
        }
    }
}

fn split_delim_aware<'a>(s: &'a str, dch: char) -> Vec<&'a str> {
    let bytes = s.as_bytes();
    let mut out: Vec<&'a str> = Vec::new();
    let mut in_str = false;
    let mut escape = false;
    let mut start = 0usize;
    let delim = dch as u8;
    let len = bytes.len();
    let mut braces = 0usize;
    let mut i = 0usize;
    while i < len {
        let b = bytes[i];
        if in_str {
            if escape {
                escape = false;
                i += 1;
                continue;
            }
            match b {
                b'\\' => {
                    escape = true;
                }
                b'"' => {
                    in_str = false;
                }
                _ => {}
            }
            i += 1;
            continue;
        } else {
            if b == b'"' {
                in_str = true;
                i += 1;
                continue;
            }
            if b == b'{' {
                braces += 1;
            }
            if b == b'}' {
                braces = braces.saturating_sub(1);
            }
            if b == delim && braces == 0 {
                // Preserve empty tokens for spec compliance
                let token = trim_ascii(&s[start..i]);
                out.push(token);
                start = i + 1;
            }
            i += 1;
        }
    }
    if start <= len {
        let token = trim_ascii(&s[start..len]);
        out.push(token);
    }
    out
}

fn trim_ascii(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut end = bytes.len();
    while start < end && matches!(bytes[start], b' ' | b'\t') {
        start += 1;
    }
    while end > start && matches!(bytes[end - 1], b' ' | b'\t') {
        end -= 1;
    }
    &s[start..end]
}

fn trim_ascii_start(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut start = 0usize;
    while start < bytes.len() && matches!(bytes[start], b' ' | b'\t') {
        start += 1;
    }
    &s[start..]
}

// Split a "key: value" pair in a single line, respecting quotes around the key and value
fn split_kv_quote_aware(s: &str) -> Option<(&str, &str)> {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    let mut in_str = false;
    let mut escape = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        } else {
            if b == b'"' {
                in_str = true;
                i += 1;
                continue;
            }
            if b == b':' {
                let key = trim_ascii(&s[..i]);
                let val = if i + 1 < s.len() {
                    trim_ascii_start(&s[i + 1..])
                } else {
                    ""
                };
                return Some((key, val));
            }
            i += 1;
        }
    }
    None
}

fn is_quoted_token(s: &str) -> bool {
    let t = trim_ascii(s);
    t.starts_with('"') && t.ends_with('"') && t.len() >= 2
}

fn token_requires_quotes(s: &str, dch: char) -> bool {
    use crate::options::Delimiter;
    let delim = match dch {
        ',' => Delimiter::Comma,
        '\t' => Delimiter::Tab,
        '|' => Delimiter::Pipe,
        _ => Delimiter::Comma,
    };
    crate::encode::primitives::needs_quotes(s, delim)
}

fn cell_token_requires_quotes(s: &str, dch: char) -> bool {
    // Stricter check for row cells that ignores numeric/boolean-like tokens,
    // focusing only on characters that would break parsing if left unquoted.
    if s.is_empty() {
        return true;
    }
    let t = trim_ascii(s);
    if t.is_empty() {
        return true;
    }
    // Delimiter presence would have split already for unquoted tokens, but keep for safety
    if t.contains(dch) {
        return true;
    }
    // Unquoted colon is ambiguous inside cells
    if t.contains(':') {
        return true;
    }
    // Dangerous characters requiring escaping in quoted strings
    if t.chars()
        .any(|c| c == '"' || c == '\\' || is_control_char(c))
    {
        return true;
    }
    // Leading/trailing spaces would be lost; enforce quoting
    if t.starts_with(' ') || t.ends_with(' ') {
        return true;
    }
    // A lone hyphen or strings starting with hyphen (non-numeric) can be ambiguous; require quotes
    if t == "-" {
        return true;
    }
    // If it starts with '-' but is not a valid number, require quotes
    if t.starts_with('-') && t.parse::<f64>().is_err() {
        return true;
    }
    // If it starts with '+', it's numeric-like and requires quotes for clarity
    if t.starts_with('+') {
        return true;
    }
    false
}

fn is_control_char(c: char) -> bool {
    let u = c as u32;
    u < 0x20 || u == 0x7F
}

pub fn parse_to_internal_value(input: &str) -> Value {
    let mut p = Parser::from_input(input);
    p.parse_document()
}

pub fn parse_to_internal_value_from_lines<'a>(
    lines: Vec<ParsedLine<'a>>,
    strict: bool,
) -> Result<Value, crate::error::Error> {
    parse_to_internal_value_from_lines_with_options(lines, strict, 2, true)
}

pub(crate) fn parse_to_internal_value_from_lines_with_options<'a>(
    lines: Vec<ParsedLine<'a>>,
    strict: bool,
    indent_size: usize,
    mark_quoted_dots: bool,
) -> Result<Value, crate::error::Error> {
    let mut p = Parser::from_lines(lines, strict);
    p.indent_size = if indent_size == 0 { 2 } else { indent_size };
    p.mark_quoted_dots = mark_quoted_dots;
    let v = p.parse_document();
    if let Some(err) = p.error {
        Err(err)
    } else {
        Ok(v)
    }
}

pub fn parse_to_value_with_strict(input: &str, strict: bool) -> Result<Value, crate::error::Error> {
    validate_header_syntax(input, strict)?;
    let mut p = Parser::from_input_with_strict(input, strict);
    let v = p.parse_document();
    if let Some(err) = p.error {
        Err(err)
    } else {
        Ok(v)
    }
}

pub(crate) fn validate_header_syntax(input: &str, strict: bool) -> Result<(), crate::error::Error> {
    for (line_no, raw) in input.lines().enumerate() {
        let line = raw.trim_start_matches(' ');
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let Some(open) = find_unquoted_bracket(line) else {
            continue;
        };
        let Some(close_rel) = find_matching_bracket(line, open) else {
            if strict {
                return Err(crate::error::Error::Syntax {
                    line: line_no + 1,
                    message: "unclosed array header".into(),
                });
            }
            continue;
        };
        let content = &line[open + 1..close_rel];
        if !strict {
            continue;
        }
        let prefix = &line[..open];
        if let Some((key_part, value_part)) = split_kv_quote_aware(line) {
            let colon = key_part.len();
            if colon < open && !prefix[colon + 1..].trim().is_empty() {
                continue;
            }
            let _ = value_part;
        }
        let is_value_header = prefix.trim_end().ends_with(':');
        let suffix = &line[close_rel + 1..];
        let header_like = suffix.contains(':') || suffix.starts_with('{');
        if !header_like {
            continue;
        }
        let malformed = || crate::error::Error::Syntax {
            line: line_no + 1,
            message: "malformed array header".into(),
        };
        if content.is_empty() {
            return Err(malformed());
        }
        let keyed = content.contains(':');
        let (length, delimiter) = if keyed {
            let (n, tail) = content.split_once(':').unwrap();
            let delimiter = if tail.is_empty() {
                None
            } else if tail == "\t" || tail == "|" {
                Some(tail)
            } else {
                return Err(malformed());
            };
            (n, delimiter)
        } else {
            let (n, delimiter) = content.strip_suffix('\t').map_or_else(
                || {
                    content
                        .strip_suffix('|')
                        .map_or((content, None), |n| (n, Some("|")))
                },
                |n| (n, Some("\t")),
            );
            (n, delimiter)
        };
        let canonical_len = !length.is_empty()
            && length.bytes().all(|b| b.is_ascii_digit())
            && (length == "0" || !length.starts_with('0'));
        if !canonical_len {
            if strict || content.is_empty() {
                return Err(malformed());
            }
            continue;
        }
        let _ = delimiter;
        let key_prefix = prefix.strip_prefix("- ").unwrap_or(prefix);
        if !is_value_header && key_prefix.chars().last().is_some_and(char::is_whitespace) {
            return Err(malformed());
        }
        let after = &line[close_rel + 1..];
        if after.starts_with('{') {
            let fields_start = 0;
            let Some(fields_end) = find_matching_brace(after, fields_start) else {
                return Err(malformed());
            };
            if fields_end == fields_start + 1 {
                return Err(malformed());
            }
            let rest = &after[fields_end + 1..];
            if !rest.starts_with(':') {
                if strict {
                    return Err(malformed());
                }
                continue;
            }
            let field_text = &after[fields_start + 1..fields_end];
            if strict {
                let delim = delimiter.map_or(',', |s| s.chars().next().unwrap_or(','));
                let tokens = split_delim_aware(field_text, delim);
                if tokens.iter().any(|token| token.trim().is_empty()) {
                    return Err(malformed());
                }
                let mut seen = BTreeSet::new();
                for token in tokens {
                    let top = token.split('{').next().unwrap_or(token).trim();
                    if !seen.insert(top.to_owned()) {
                        return Err(malformed());
                    }
                }
            }
        } else if !after.starts_with(':') && strict {
            return Err(malformed());
        }
    }
    Ok(())
}

#[cfg(feature = "json")]
pub fn parse_to_value(input: &str) -> serde_json::Value {
    let v = parse_to_internal_value(input);
    to_json_value(v)
}

#[cfg(feature = "json")]
fn to_json_value(v: Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => serde_json::Value::Bool(b),
        Value::Number(n) => match n {
            Number::I64(i) => serde_json::Value::Number(i.into()),
            Number::U64(u) => serde_json::Value::Number(u.into()),
            Number::F64(f) => serde_json::Number::from_f64(f)
                .map(serde_json::Value::Number)
                .unwrap_or_else(|| serde_json::Value::String(f.to_string())),
        },
        Value::String(s) => serde_json::Value::String(s),
        Value::Array(a) => serde_json::Value::Array(a.into_iter().map(to_json_value).collect()),
        Value::Object(pairs) => {
            let mut m = serde_json::Map::new();
            for (k, vv) in pairs {
                m.insert(k, to_json_value(vv));
            }
            serde_json::Value::Object(m)
        }
    }
}

#[derive(Debug, Clone)]
enum StringParseError {
    Unterminated,
    InvalidEscape,
}

fn try_unescape_json_string(s: &str) -> Result<String, StringParseError> {
    // Check for proper termination: must start with " and end with "
    if !s.starts_with('"') {
        return Err(StringParseError::Unterminated);
    }
    if s.len() < 2 || !s.ends_with('"') {
        return Err(StringParseError::Unterminated);
    }
    let inner = &s[1..s.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                None => return Err(StringParseError::InvalidEscape),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('/') => out.push('/'),
                Some('b') => out.push('\u{0008}'),
                Some('f') => out.push('\u{000C}'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('u') => {
                    let mut code = 0u32;
                    for _ in 0..4 {
                        let d = chars.next().ok_or(StringParseError::InvalidEscape)?;
                        code = (code << 4) | hex_val(d).ok_or(StringParseError::InvalidEscape)?;
                    }
                    if let Some(c) = core::char::from_u32(code) {
                        out.push(c);
                    } else {
                        return Err(StringParseError::InvalidEscape);
                    }
                }
                Some(_) => return Err(StringParseError::InvalidEscape),
            }
        } else {
            out.push(ch);
        }
    }
    Ok(out)
}

#[derive(Copy, Clone)]
enum NumHint {
    IntSigned,
    IntUnsigned,
    Float,
}

fn classify_numeric_hint(s: &str) -> Option<NumHint> {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes[0] == b'"' {
        return None;
    }
    let mut i = usize::from(bytes[0] == b'-');
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == int_start {
        return None;
    }
    let mut fractional = false;
    if i < bytes.len() && bytes[i] == b'.' {
        fractional = true;
        i += 1;
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
    }
    let mut exponent = false;
    if i < bytes.len() && matches!(bytes[i], b'e' | b'E') {
        exponent = true;
        i += 1;
        if i < bytes.len() && matches!(bytes[i], b'+' | b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    if fractional || exponent {
        Some(NumHint::Float)
    } else if bytes[0] == b'-' {
        Some(NumHint::IntSigned)
    } else {
        Some(NumHint::IntUnsigned)
    }
}

fn hex_val(c: char) -> Option<u32> {
    match c {
        '0'..='9' => Some((c as u32) - ('0' as u32)),
        'a'..='f' => Some(10 + (c as u32) - ('a' as u32)),
        'A'..='F' => Some(10 + (c as u32) - ('A' as u32)),
        _ => None,
    }
}
