//! `__zunaDb`: SQLite for the core's LocalDb (apps/ios/core-bundle/src/db.ts), as the
//! iOS host's DatabaseBridge.swift gives it. Every call is synchronous, on the core's thread.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use rquickjs::function::Rest;
use rquickjs::{Array, Ctx, Function, Object, Result, Value};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, params_from_iter};

use super::js::*;

struct Databases {
    dir: PathBuf,
    open: HashMap<u32, Connection>,
    names: HashMap<String, u32>,
    next: u32,
}

/// A database's name as a file name: the core's names are its own, but a name is never a path.
fn file_for(dir: &Path, name: &str) -> PathBuf {
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    dir.join(format!("{safe}.sqlite"))
}

fn to_sql(value: &Value<'_>) -> SqlValue {
    if value.is_null() || value.is_undefined() {
        return SqlValue::Null;
    }
    if let Some(flag) = value.as_bool() {
        return SqlValue::Integer(flag as i64);
    }
    if let Some(integer) = value.as_int() {
        return SqlValue::Integer(integer as i64);
    }
    if let Some(number) = value.as_float() {
        // Whole numbers are stored as integers, as they are from the desktop's SQLite.
        if number.fract() == 0.0 && number.abs() < 9.007_199_254_740_992e15 {
            return SqlValue::Integer(number as i64);
        }
        return SqlValue::Real(number);
    }
    if let Some(text) = value.as_string() {
        return SqlValue::Text(text.to_string().unwrap_or_default());
    }
    if let Some(bytes) = read_bytes(value) {
        return SqlValue::Blob(bytes);
    }
    SqlValue::Null
}

fn params(args: &[Value<'_>]) -> Vec<SqlValue> {
    args.get(2)
        .and_then(|value| value.as_array())
        .map(|array| array.iter::<Value>().filter_map(|item| item.ok()).map(|item| to_sql(&item)).collect())
        .unwrap_or_default()
}

fn value_of<'js>(ctx: &Ctx<'js>, value: ValueRef<'_>) -> Result<Value<'js>> {
    Ok(match value {
        ValueRef::Null => Value::new_null(ctx.clone()),
        ValueRef::Integer(integer) => {
            if let Ok(small) = i32::try_from(integer) {
                Value::new_int(ctx.clone(), small)
            } else {
                Value::new_number(ctx.clone(), integer as f64)
            }
        }
        ValueRef::Real(real) => Value::new_number(ctx.clone(), real),
        ValueRef::Text(text) => rquickjs::String::from_str(ctx.clone(), &String::from_utf8_lossy(text))?.into_value(),
        ValueRef::Blob(bytes) => new_bytes(ctx, bytes)?,
    })
}

pub fn install<'js>(ctx: &Ctx<'js>, dir: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&dir).ok();
    let state = Rc::new(RefCell::new(Databases { dir, open: HashMap::new(), names: HashMap::new(), next: 1 }));
    let db = Object::new(ctx.clone())?;

    {
        let state = state.clone();
        db.set(
            "open",
            Function::new(ctx.clone(), move |c: Ctx<'js>, Rest(a): Rest<Value<'js>>| -> Result<Value<'js>> {
                let name = string_arg(&a, 0);
                let mut state = state.borrow_mut();
                if let Some(handle) = state.names.get(&name) {
                    return Ok(number(&c, *handle as f64));
                }
                let path = file_for(&state.dir, &name);
                let connection = Connection::open(&path).map_err(|error| fail(&c, format!("Couldn't open {name}: {error}")))?;
                connection
                    .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -16000;")
                    .map_err(|error| fail(&c, error.to_string()))?;
                connection.set_prepared_statement_cache_capacity(256);
                let handle = state.next;
                state.next += 1;
                state.open.insert(handle, connection);
                state.names.insert(name, handle);
                Ok(number(&c, handle as f64))
            })?,
        )?;
    }
    {
        let state = state.clone();
        db.set(
            "run",
            Function::new(ctx.clone(), move |c: Ctx<'js>, Rest(a): Rest<Value<'js>>| -> Result<Value<'js>> {
                let state = state.borrow();
                let connection = state.open.get(&(number_arg(&a, 0) as u32)).ok_or_else(|| fail(&c, "That database isn't open."))?;
                let sql = string_arg(&a, 1);
                let values = params(&a);
                if values.is_empty() {
                    // Several statements at once, such as a migration, or BEGIN and COMMIT.
                    connection.execute_batch(&sql).map_err(|error| fail(&c, error.to_string()))?;
                } else {
                    let mut statement = connection.prepare_cached(&sql).map_err(|error| fail(&c, error.to_string()))?;
                    statement.execute(params_from_iter(values.iter())).map_err(|error| fail(&c, error.to_string()))?;
                }
                Ok(Value::new_undefined(c))
            })?,
        )?;
    }
    {
        let state = state.clone();
        db.set(
            "all",
            Function::new(ctx.clone(), move |c: Ctx<'js>, Rest(a): Rest<Value<'js>>| -> Result<Value<'js>> {
                let state = state.borrow();
                let connection = state.open.get(&(number_arg(&a, 0) as u32)).ok_or_else(|| fail(&c, "That database isn't open."))?;
                let sql = string_arg(&a, 1);
                let values = params(&a);
                let mut statement = connection.prepare_cached(&sql).map_err(|error| fail(&c, error.to_string()))?;
                let names: Vec<String> = statement.column_names().map(|name| name.to_string()).collect();
                let mut rows = statement.query(params_from_iter(values.iter())).map_err(|error| fail(&c, error.to_string()))?;
                let result = Array::new(c.clone())?;
                let mut index = 0;
                while let Some(row) = rows.next().map_err(|error| fail(&c, error.to_string()))? {
                    let object = Object::new(c.clone())?;
                    for (column, name) in names.iter().enumerate() {
                        let value = row.get_ref(column).map_err(|error| fail(&c, error.to_string()))?;
                        object.set(name.as_str(), value_of(&c, value)?)?;
                    }
                    result.set(index, object)?;
                    index += 1;
                }
                Ok(result.into_value())
            })?,
        )?;
    }
    {
        let state = state.clone();
        db.set(
            "close",
            Function::new(ctx.clone(), move |c: Ctx<'js>, Rest(a): Rest<Value<'js>>| -> Result<Value<'js>> {
                let mut state = state.borrow_mut();
                let handle = number_arg(&a, 0) as u32;
                state.open.remove(&handle);
                state.names.retain(|_, open| *open != handle);
                Ok(Value::new_undefined(c))
            })?,
        )?;
    }
    {
        let state = state.clone();
        db.set(
            "remove",
            Function::new(ctx.clone(), move |c: Ctx<'js>, Rest(a): Rest<Value<'js>>| -> Result<Value<'js>> {
                let name = string_arg(&a, 0);
                let mut state = state.borrow_mut();
                if let Some(handle) = state.names.remove(&name) {
                    state.open.remove(&handle);
                }
                let base = file_for(&state.dir, &name);
                for suffix in ["", "-wal", "-shm", "-journal"] {
                    let mut path = base.clone().into_os_string();
                    path.push(suffix);
                    std::fs::remove_file(path).ok();
                }
                Ok(Value::new_undefined(c))
            })?,
        )?;
    }

    ctx.globals().set("__zunaDb", db)?;
    Ok(())
}
