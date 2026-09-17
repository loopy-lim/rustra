//! Ordinary functions used by the React Native `functions` demo.
//! No Rustra attributes, argument DTOs, or mandatory Result return values.
use rustra::{PackageBuilder, RustraError};
use std::sync::Arc;
use std::sync::atomic::{AtomicI32, Ordering};

fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn greet_person(name: String) -> String {
    format!("Hello, {name}!")
}

enum DivideError {
    ZeroDivisor,
}

fn safe_divide(a: f64, b: f64) -> Result<f64, DivideError> {
    if b == 0.0 {
        Err(DivideError::ZeroDivisor)
    } else {
        Ok(a / b)
    }
}

pub(crate) fn register(builder: PackageBuilder) -> PackageBuilder {
    let memory = Arc::new(AtomicI32::new(0));
    let remember = Arc::clone(&memory);
    let recall = Arc::clone(&memory);
    builder
        .function("add", add)
        .function("greetPerson", greet_person)
        .try_function("safeDivide", safe_divide, |_| {
            RustraError::custom("math.zero_divisor", "Cannot divide by zero")
        })
        .function("remember", move |value: i32| {
            remember.store(value, Ordering::Relaxed);
        })
        .function("readRemembered", move || recall.load(Ordering::Relaxed))
        .function("reset", move || {
            memory.store(0, Ordering::Relaxed);
        })
}
