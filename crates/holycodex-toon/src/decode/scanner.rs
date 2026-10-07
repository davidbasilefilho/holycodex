#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLine<'a> {
    pub indent: usize,
    pub kind: LineKind<'a>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineKind<'a> {
    Blank,
    KeyValue { key: &'a str, value: &'a str },
    KeyOnly { key: &'a str },
    ListItem { value: Option<&'a str> },
    Scalar(&'a str),
}

fn leading_indent(s: &str) -> (usize, usize) {
    let mut bytes = 0;
    let mut spaces = 0;
    for b in s.bytes() {
        match b {
            b' ' => {
                bytes += 1;
                spaces += 1;
            }
            b'\t' => {
                bytes += 1;
                spaces += 2;
            }
            _ => break,
        }
    }
    (spaces, bytes)
}

#[inline]
fn find_unquoted_colon(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut in_str = false;
    let mut escape = false;
    let mut in_bracket = false;
    for (i, &ch) in b.iter().enumerate() {
        if in_str {
            if escape {
                escape = false;
                continue;
            }
            match ch {
                b'\\' => {
                    escape = true;
                }
                b'"' => {
                    in_str = false;
                }
                _ => {}
            }
        } else {
            match ch {
                b'"' => {
                    in_str = true;
                }
                b'[' => in_bracket = true,
                b']' => in_bracket = false,
                b':' if !in_bracket => {
                    return Some(i);
                }
                _ => {}
            }
        }
    }
    None
}

pub fn scan<'a>(input: &'a str) -> Vec<ParsedLine<'a>> {
    let mut out = Vec::new();
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    for raw in input.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim_end_matches(' ');
        let (indent, offset) = leading_indent(line);
        let body = &line[offset..];
        if raw.trim_start_matches(' ').starts_with('#') {
            continue;
        }
        if body.is_empty() {
            out.push(ParsedLine {
                indent,
                kind: LineKind::Blank,
            });
            continue;
        }
        if let Some(rest) = body.strip_prefix("- ") {
            out.push(ParsedLine {
                indent,
                kind: LineKind::ListItem { value: Some(rest) },
            });
            continue;
        }
        if body == "-" {
            out.push(ParsedLine {
                indent,
                kind: LineKind::ListItem { value: None },
            });
            continue;
        }
        if body.starts_with('@') {
            // Table header line; treat entire line as scalar
            out.push(ParsedLine {
                indent,
                kind: LineKind::Scalar(body),
            });
            continue;
        }
        if let Some(idx) = find_unquoted_colon(body) {
            let (k, v) = body.split_at(idx);
            let after = &v[1..];
            let after_trimmed = trim_ascii(after);
            if after_trimmed.is_empty() {
                out.push(ParsedLine {
                    indent,
                    kind: LineKind::KeyOnly { key: k },
                });
            } else {
                out.push(ParsedLine {
                    indent,
                    kind: LineKind::KeyValue {
                        key: k,
                        value: trim_ascii_start(after),
                    },
                });
            }
            continue;
        }
        out.push(ParsedLine {
            indent,
            kind: LineKind::Scalar(body),
        });
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
