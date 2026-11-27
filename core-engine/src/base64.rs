// Copyright 2026 Blue Frog Foundation
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Standard RFC 4648 base64 encoding and decoding helpers.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encodes `data` into standard base64 with `=` padding.
#[must_use]
pub fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map(u32::from).unwrap_or(0);
        let b2 = chunk.get(2).copied().map(u32::from).unwrap_or(0);
        let n = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn decode_sextet(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a' + 26)),
        b'0'..=b'9' => Some(u32::from(byte - b'0' + 52)),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decodes a standard base64 string (ignoring ASCII whitespace).
pub fn decode(input: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !clean.len().is_multiple_of(4) {
        return Err("Invalid base64 length".to_string());
    }

    let (chunks, _) = clean.as_chunks::<4>();
    let chunk_count = chunks.len();
    let mut out = Vec::with_capacity((chunk_count * 3).saturating_sub(2));

    for (idx, &[c0, c1, c2, c3]) in chunks.iter().enumerate() {
        let is_last = idx + 1 == chunk_count;
        if c0 == b'=' || c1 == b'=' {
            return Err("Invalid base64 padding".to_string());
        }
        if !is_last && (c2 == b'=' || c3 == b'=') {
            return Err("Invalid base64 mid-stream padding".to_string());
        }
        if c2 == b'=' && c3 != b'=' {
            return Err("Invalid base64 padding".to_string());
        }

        let v0 = decode_sextet(c0).ok_or_else(|| "Invalid base64 character".to_string())?;
        let v1 = decode_sextet(c1).ok_or_else(|| "Invalid base64 character".to_string())?;
        let v2 = if c2 == b'=' {
            0
        } else {
            decode_sextet(c2).ok_or_else(|| "Invalid base64 character".to_string())?
        };
        let v3 = if c3 == b'=' {
            0
        } else {
            decode_sextet(c3).ok_or_else(|| "Invalid base64 character".to_string())?
        };

        let n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
        out.push(((n >> 16) & 0xff) as u8);
        if c2 != b'=' {
            out.push(((n >> 8) & 0xff) as u8);
        }
        if c3 != b'=' {
            out.push((n & 0xff) as u8);
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip() {
        for raw in [
            b"".as_slice(),
            b"f",
            b"fo",
            b"foo",
            b"foob",
            b"fooba",
            b"foobar",
            b"\x00\xff\x10\x80\x7f",
        ] {
            let encoded = encode(raw);
            let decoded = decode(&encoded).unwrap();
            assert_eq!(decoded, raw);
        }
    }

    #[test]
    fn decode_handles_whitespace_and_rejects_malformed() {
        assert_eq!(decode("Zm 9v\nYm Fy").unwrap(), b"foobar");
        assert!(decode("abc").is_err());
        assert!(decode("=AAA").is_err());
        assert!(decode("AA=A").is_err());
        assert!(decode("Zm==AAAA").is_err());
        assert!(decode("Zm$v").is_err());
    }
}
