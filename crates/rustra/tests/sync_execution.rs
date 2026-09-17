use rustra::{Package, command};

#[command]
fn immediate(input: u32) -> rustra::Result<u32> {
    Ok(input + 1)
}
#[command]
async fn deferred(input: u32) -> rustra::Result<u32> {
    Ok(input + 2)
}

#[test]
fn macro_registration_preserves_original_execution_kind() {
    let package = rustra::build!("sync-test", immediate, deferred).build();
    let schema = package.live_schema();
    let commands = schema["commands"].as_array().unwrap();
    assert_eq!(
        commands.iter().find(|c| c["name"] == "immediate").unwrap()["execution"],
        "sync"
    );
    assert_eq!(
        commands.iter().find(|c| c["name"] == "deferred").unwrap()["execution"],
        "async"
    );
    assert_eq!(deferred(1).unwrap(), 3);
}

#[test]
fn unannotated_registration_does_not_claim_sync_eligibility() {
    let package = Package::builder("unknown").command_fn(immediate).build();
    assert!(
        package.live_schema()["commands"][0]
            .get("execution")
            .is_none()
    );
}

#[test]
fn freezing_refreshes_cached_live_metadata_without_changing_contract() {
    let package = rustra::build!("freeze-test", immediate).build();
    let before = package.live_schema();
    let contract = package.generate_typescript().unwrap().schema_json;
    package.freeze();
    let after = package.live_schema();
    assert_eq!(after["registryFrozen"], true);
    assert_eq!(package.generate_typescript().unwrap().schema_json, contract);
    if before["registryFrozen"] == false {
        assert_ne!(before["schemaGeneration"], after["schemaGeneration"]);
    }
}

#[test]
fn manual_producer_metadata_changes_contract_without_changing_ids_or_wire() {
    use rustra::CommandExecution;
    let unknown = Package::builder("manual")
        .command("manual", |v: u32| Ok(v + 1))
        .build();
    let known = Package::builder("manual")
        .command("manual", |v: u32| Ok(v + 1))
        .command_execution("manual", CommandExecution::Sync)
        .build();
    let a = unknown.live_schema();
    let b = known.live_schema();
    assert_eq!(a["commands"][0]["commandId"], b["commands"][0]["commandId"]);
    assert_eq!(b["commands"][0]["execution"], "sync");
    assert_ne!(
        unknown.generate_typescript().unwrap().contract_ts,
        known.generate_typescript().unwrap().contract_ts
    );
    assert_eq!(
        unknown.invoke_frame(&[1, 0, 3]).unwrap(),
        known.invoke_frame(&[1, 0, 3]).unwrap()
    );
}

#[test]
fn replacing_a_known_handler_does_not_inherit_its_execution_claim() {
    let package = rustra::build!("replace", immediate).build();
    if package.is_frozen() {
        return;
    }
    package.replace("immediate", deferred).unwrap();
    assert!(
        package.live_schema()["commands"][0]
            .get("execution")
            .is_none()
    );
    assert_eq!(
        package
            .invoke_json("immediate", serde_json::json!(1))
            .unwrap(),
        3
    );
}
