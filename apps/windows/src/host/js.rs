//! Moving values between QuickJS and Rust.

use rquickjs::{Array, Ctx, Exception, FromJs, IntoJs, Object, Result, TypedArray, Value};

/// The bytes of a typed array, an array buffer or a data view, or nothing.
pub fn read_bytes(value: &Value<'_>) -> Option<Vec<u8>> {
    let object = value.as_object()?;
    // SAFETY (each as_bytes): no JavaScript runs while the slice is alive.
    if let Some(buffer) = object.as_array_buffer() {
        return unsafe { buffer.as_bytes() }.map(<[u8]>::to_vec);
    }
    if let Some(array) = object.as_typed_array::<u8>() {
        return unsafe { array.as_bytes() }.map(<[u8]>::to_vec);
    }
    // Any other view: its bytes in its buffer.
    let buffer: Object = object.get("buffer").ok()?;
    let buffer = buffer.as_array_buffer()?;
    let offset: usize = object.get("byteOffset").ok()?;
    let length: usize = object.get("byteLength").ok()?;
    unsafe { buffer.as_bytes() }?.get(offset..offset + length).map(<[u8]>::to_vec)
}

/// The numbers of a Uint32Array, or of a plain array of numbers.
pub fn read_u32s(value: &Value<'_>) -> Vec<u32> {
    let Some(object) = value.as_object() else { return Vec::new() };
    if let Some(array) = object.as_typed_array::<u32>() {
        // SAFETY: no JavaScript runs while the slice is alive.
        return unsafe { array.as_slice() }.to_vec();
    }
    if let Some(array) = object.as_array() {
        return array.iter::<f64>().filter_map(|item| item.ok()).map(|item| item as u32).collect();
    }
    Vec::new()
}

/// The bytes of an argument, or empty, as the Swift host reads them.
pub fn bytes_arg(args: &[Value<'_>], index: usize) -> Vec<u8> {
    args.get(index).and_then(read_bytes).unwrap_or_default()
}

/// The bytes of an argument that may be null or undefined.
pub fn optional_bytes_arg(args: &[Value<'_>], index: usize) -> Option<Vec<u8>> {
    let value = args.get(index)?;
    if value.is_null() || value.is_undefined() {
        return None;
    }
    read_bytes(value)
}

pub fn number_arg(args: &[Value<'_>], index: usize) -> f64 {
    args.get(index).and_then(|value| value.as_number()).unwrap_or(0.0)
}

pub fn bool_arg(args: &[Value<'_>], index: usize) -> bool {
    args.get(index).and_then(|value| value.as_bool()).unwrap_or(false)
}

pub fn string_arg(args: &[Value<'_>], index: usize) -> String {
    args.get(index)
        .and_then(|value| value.as_string())
        .and_then(|string| string.to_string().ok())
        .unwrap_or_default()
}

pub fn new_bytes<'js>(ctx: &Ctx<'js>, bytes: impl AsRef<[u8]>) -> Result<Value<'js>> {
    Ok(TypedArray::<u8>::new_copy(ctx.clone(), bytes.as_ref())?.into_value())
}

pub fn optional_bytes<'js>(ctx: &Ctx<'js>, bytes: Option<impl AsRef<[u8]>>) -> Result<Value<'js>> {
    match bytes {
        Some(bytes) => new_bytes(ctx, bytes),
        None => Ok(Value::new_null(ctx.clone())),
    }
}

pub fn bytes_array<'js>(ctx: &Ctx<'js>, items: &[Vec<u8>]) -> Result<Value<'js>> {
    let array = Array::new(ctx.clone())?;
    for (index, item) in items.iter().enumerate() {
        array.set(index, new_bytes(ctx, item)?)?;
    }
    Ok(array.into_value())
}

pub fn object<'js>(ctx: &Ctx<'js>, fields: Vec<(&str, Value<'js>)>) -> Result<Value<'js>> {
    let object = Object::new(ctx.clone())?;
    for (key, value) in fields {
        object.set(key, value)?;
    }
    Ok(object.into_value())
}

pub fn number<'js>(ctx: &Ctx<'js>, value: f64) -> Value<'js> {
    Value::new_number(ctx.clone(), value)
}

pub fn boolean<'js>(ctx: &Ctx<'js>, value: bool) -> Value<'js> {
    Value::new_bool(ctx.clone(), value)
}

/// Throws a JavaScript Error with this message.
pub fn fail(ctx: &Ctx<'_>, message: impl AsRef<str>) -> rquickjs::Error {
    Exception::throw_message(ctx, message.as_ref())
}

/// Turns a crypto result into a value or a thrown Error.
pub fn check<'js, T>(ctx: &Ctx<'js>, result: std::result::Result<T, String>) -> Result<T> {
    result.map_err(|message| fail(ctx, message))
}

/// A thrown value as text, with its stack if it has one.
pub fn describe_exception(ctx: &Ctx<'_>) -> String {
    let caught = ctx.catch();
    if let Some(exception) = caught.as_exception() {
        let message = exception.message().unwrap_or_default();
        let stack = exception.stack().unwrap_or_default();
        return format!("{message}\n{stack}");
    }
    if let Ok(text) = String::from_js(ctx, caught.clone()) {
        return text;
    }
    ctx.json_stringify(caught)
        .ok()
        .flatten()
        .and_then(|text| text.to_string().ok())
        .unwrap_or_else(|| "an unknown error".into())
}

pub fn into_value<'js, T: IntoJs<'js>>(ctx: &Ctx<'js>, value: T) -> Result<Value<'js>> {
    value.into_js(ctx)
}
