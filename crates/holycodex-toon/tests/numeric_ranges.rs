#![cfg(feature = "serde")]

use holycodex_toon::{Options, decode_from_str};

#[test]
fn integer_valued_exponents_do_not_saturate_at_integer_bounds() {
    for token in [
        "1e30",
        "-1e30",
        "18446744073709551616e0",
        "-9223372036854777856e0",
    ] {
        let expected: f64 = token.parse().unwrap();
        assert_eq!(
            decode_from_str::<f64>(token, &Options::default()).unwrap(),
            expected
        );
        #[cfg(feature = "de_direct")]
        assert_eq!(
            holycodex_toon::de::direct::from_str::<f64>(token, &Options::default()).unwrap(),
            expected
        );
    }
    for (token, expected) in [
        ("42e0", 42_u64),
        ("18446744073709549568e0", 18_446_744_073_709_549_568_u64),
    ] {
        assert_eq!(
            decode_from_str::<u64>(token, &Options::default()).unwrap(),
            expected
        );
    }
    assert_eq!(
        decode_from_str::<i64>("-9223372036854775808e0", &Options::default()).unwrap(),
        i64::MIN
    );
}
