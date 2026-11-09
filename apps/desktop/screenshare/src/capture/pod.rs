//! Builds and reads SPA PODs, the format PipeWire negotiates in. The C headers do this
//! with inline functions that a dlopen can't reach, so it's written out here against
//! spa/pod/pod.h. Nothing in this file depends on Linux, so its tests run anywhere.

pub const TYPE_ID: u32 = 3;
pub const TYPE_INT: u32 = 4;
pub const TYPE_LONG: u32 = 5;
pub const TYPE_RECTANGLE: u32 = 10;
pub const TYPE_FRACTION: u32 = 11;
pub const TYPE_ARRAY: u32 = 13;
pub const TYPE_OBJECT: u32 = 15;
pub const TYPE_CHOICE: u32 = 19;

pub const CHOICE_RANGE: u32 = 1;
pub const CHOICE_ENUM: u32 = 3;

pub const PROP_MANDATORY: u32 = 1 << 3;
pub const PROP_DONT_FIXATE: u32 = 1 << 4;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Id(u32),
    Int(i32),
    Long(i64),
    Rectangle(u32, u32),
    Fraction(u32, u32),
    /// The first value is the default, and the rest depend on the kind: an enum's
    /// alternatives, or a range's minimum and maximum.
    Choice(u32, Vec<Value>),
    /// Values of one type, such as the channels of a sound.
    Array(Vec<Value>),
}

impl Value {
    fn type_id(&self) -> u32 {
        match self {
            Value::Id(_) => TYPE_ID,
            Value::Int(_) => TYPE_INT,
            Value::Long(_) => TYPE_LONG,
            Value::Rectangle(..) => TYPE_RECTANGLE,
            Value::Fraction(..) => TYPE_FRACTION,
            Value::Choice(..) => TYPE_CHOICE,
            Value::Array(_) => TYPE_ARRAY,
        }
    }

    fn body(&self) -> Vec<u8> {
        let pair = |a: u32, b: u32| [a.to_ne_bytes(), b.to_ne_bytes()].concat();
        match self {
            Value::Id(value) => value.to_ne_bytes().to_vec(),
            Value::Int(value) => value.to_ne_bytes().to_vec(),
            Value::Long(value) => value.to_ne_bytes().to_vec(),
            Value::Rectangle(a, b) | Value::Fraction(a, b) => pair(*a, *b),
            Value::Choice(kind, values) => {
                let first = values.first().expect("A choice has at least a default");
                let child_size = first.body().len() as u32;
                let mut body = pair(*kind, 0);
                body.extend(pair(child_size, first.type_id()));
                for value in values {
                    body.extend(value.body());
                }
                body
            }
            Value::Array(values) => {
                let first = values.first().expect("An array says its type through its first value");
                let mut body = pair(first.body().len() as u32, first.type_id());
                for value in values {
                    body.extend(value.body());
                }
                body
            }
        }
    }

    fn write(&self, out: &mut Vec<u8>) {
        let body = self.body();
        out.extend((body.len() as u32).to_ne_bytes());
        out.extend(self.type_id().to_ne_bytes());
        out.extend(body);
        pad(out);
    }
}

fn pad(out: &mut Vec<u8>) {
    while out.len() % 8 != 0 {
        out.push(0);
    }
}

/// An object POD, in 64-bit words because PipeWire reads it through aligned pointers.
pub fn object(object_type: u32, id: u32, properties: &[(u32, u32, Value)]) -> Vec<u64> {
    let mut body = Vec::new();
    body.extend(object_type.to_ne_bytes());
    body.extend(id.to_ne_bytes());
    for (key, flags, value) in properties {
        body.extend(key.to_ne_bytes());
        body.extend(flags.to_ne_bytes());
        value.write(&mut body);
    }
    let mut bytes = Vec::with_capacity(body.len() + 8);
    bytes.extend((body.len() as u32).to_ne_bytes());
    bytes.extend(TYPE_OBJECT.to_ne_bytes());
    bytes.extend(body);
    pad(&mut bytes);
    bytes.chunks_exact(8).map(|word| u64::from_ne_bytes(word.try_into().unwrap())).collect()
}

/// The value of one key in an object POD. A choice reads as its default, which once
/// PipeWire has fixed a format is the value that was chosen.
pub fn find(pod: &[u8], key: u32) -> Option<Value> {
    let size = read_u32(pod, 0)? as usize;
    if read_u32(pod, 4)? != TYPE_OBJECT {
        return None;
    }
    let end = (size + 8).min(pod.len());
    let mut at = 16;
    while at + 16 <= end {
        let property_key = read_u32(pod, at)?;
        let value_size = read_u32(pod, at + 8)? as usize;
        let value_type = read_u32(pod, at + 12)?;
        let body = pod.get(at + 16..at + 16 + value_size)?;
        if property_key == key {
            return read_value(value_type, body);
        }
        at += 16 + value_size.next_multiple_of(8);
    }
    None
}

fn read_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_ne_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn read_value(value_type: u32, body: &[u8]) -> Option<Value> {
    Some(match value_type {
        TYPE_ID => Value::Id(read_u32(body, 0)?),
        TYPE_INT => Value::Int(read_u32(body, 0)? as i32),
        TYPE_LONG => Value::Long(i64::from_ne_bytes(body.get(..8)?.try_into().ok()?)),
        TYPE_RECTANGLE => Value::Rectangle(read_u32(body, 0)?, read_u32(body, 4)?),
        TYPE_FRACTION => Value::Fraction(read_u32(body, 0)?, read_u32(body, 4)?),
        TYPE_CHOICE => {
            let child_size = read_u32(body, 8)? as usize;
            let child_type = read_u32(body, 12)?;
            return read_value(child_type, body.get(16..16 + child_size)?);
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(words: &[u64]) -> Vec<u8> {
        words.iter().flat_map(|word| word.to_ne_bytes()).collect()
    }

    fn u32s(data: &[u8]) -> Vec<u32> {
        data.chunks_exact(4).map(|word| u32::from_ne_bytes(word.try_into().unwrap())).collect()
    }

    #[test]
    fn lays_out_an_object_as_the_headers_say() {
        let pod = bytes(&object(0x40003, 3, &[(1, 0, Value::Id(2)), (0x20003, 0, Value::Rectangle(2560, 1440))]));
        assert_eq!(
            u32s(&pod),
            [
                // Size of what follows, not counting this header, and Object.
                56, 15,
                // The object's type and id.
                0x40003, 3,
                // A property: key, flags, then a pod. An Id takes four bytes, padded to eight.
                1, 0, 4, 3, 2, 0,
                // Next property: key, flags, then a Rectangle.
                0x20003, 0, 8, 10, 2560, 1440,
            ]
        );
    }

    #[test]
    fn lays_out_a_choice_with_its_values_packed_together() {
        let pod = bytes(&object(9, 0, &[(7, PROP_MANDATORY, Value::Choice(CHOICE_ENUM, vec![Value::Id(8), Value::Id(8), Value::Id(12)]))]));
        assert_eq!(
            u32s(&pod),
            [
                // Object header and body.
                56, 15, 9, 0,
                // Key and flags, then the choice's pod header: 8 + 8 + 3 * 4 bytes.
                7, 8, 28, 19,
                // Enum, no flags, then each child's size and type.
                3, 0, 4, 3,
                // The values, and padding to eight bytes.
                8, 8, 12, 0,
            ]
        );
    }

    #[test]
    fn lays_out_an_array_with_one_header_for_its_values() {
        let pod = bytes(&object(0x40003, 3, &[(0x10005, 0, Value::Array(vec![Value::Id(3), Value::Id(4)]))]));
        assert_eq!(
            u32s(&pod),
            [
                // Object header and body.
                40, 15, 0x40003, 3,
                // Key and flags, then the array's pod header: 8 + 2 * 4 bytes.
                0x10005, 0, 16, 13,
                // Each child's size and type, then the values.
                4, 3, 3, 4,
            ]
        );
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let modifiers = Value::Choice(CHOICE_ENUM, vec![Value::Long(0), Value::Long(0)]);
        let pod = bytes(&object(
            0x40003,
            4,
            &[
                (1, 0, Value::Id(2)),
                (0x20001, 0, Value::Id(8)),
                (0x20002, PROP_MANDATORY | PROP_DONT_FIXATE, modifiers),
                (0x20003, 0, Value::Rectangle(1920, 1080)),
                (0x20004, 0, Value::Fraction(60, 1)),
            ],
        ));
        assert_eq!(find(&pod, 0x20001), Some(Value::Id(8)));
        assert_eq!(find(&pod, 0x20002), Some(Value::Long(0)), "a choice reads as its default");
        assert_eq!(find(&pod, 0x20003), Some(Value::Rectangle(1920, 1080)));
        assert_eq!(find(&pod, 0x20004), Some(Value::Fraction(60, 1)));
        assert_eq!(find(&pod, 0x99999), None);
    }

    #[test]
    fn refuses_what_is_not_an_object_or_is_cut_short() {
        assert_eq!(find(&[], 1), None);
        assert_eq!(find(&bytes(&[0]), 1), None);
        let pod = bytes(&object(9, 0, &[(7, 0, Value::Rectangle(1, 2))]));
        assert_eq!(find(&pod[..pod.len() - 4], 7), None);
    }
}
