use rustra::prelude::*;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    pub value: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemInput {
    pub name: String,
    pub value: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemOutput {
    pub item: Item,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetItemInput {
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetItemOutput {
    pub item: Option<Item>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListItemsInput {
    pub min_value: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListItemsOutput {
    pub items: Vec<Item>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateItemInput {
    pub id: String,
    pub name: Option<String>,
    pub value: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateItemOutput {
    pub item: Option<Item>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteItemInput {
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteItemOutput {
    pub deleted: bool,
}

static STORE: std::sync::LazyLock<Mutex<HashMap<String, Item>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn next_id() -> String {
    format!(
        "{:016x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64
    )
}

#[command]
pub fn create_item(input: CreateItemInput) -> Result<CreateItemOutput> {
    let item = Item {
        id: next_id(),
        name: input.name,
        value: input.value,
    };
    let mut store = STORE.lock().unwrap();
    let id = item.id.clone();
    store.insert(id, item.clone());
    Ok(CreateItemOutput { item })
}

#[command]
pub fn get_item(input: GetItemInput) -> Result<GetItemOutput> {
    let store = STORE.lock().unwrap();
    Ok(GetItemOutput {
        item: store.get(&input.id).cloned(),
    })
}

#[command]
pub fn list_items(input: ListItemsInput) -> Result<ListItemsOutput> {
    let store = STORE.lock().unwrap();
    let items: Vec<Item> = store
        .values()
        .filter(|item| input.min_value.is_none_or(|min| item.value >= min))
        .cloned()
        .collect();
    Ok(ListItemsOutput { items })
}

#[command]
pub fn update_item(input: UpdateItemInput) -> Result<UpdateItemOutput> {
    let mut store = STORE.lock().unwrap();
    let updated = if let Some(item) = store.get_mut(&input.id) {
        if let Some(name) = input.name {
            item.name = name;
        }
        if let Some(value) = input.value {
            item.value = value;
        }
        Some(item.clone())
    } else {
        None
    };
    Ok(UpdateItemOutput { item: updated })
}

#[command]
pub fn delete_item(input: DeleteItemInput) -> Result<DeleteItemOutput> {
    let mut store = STORE.lock().unwrap();
    Ok(DeleteItemOutput {
        deleted: store.remove(&input.id).is_some(),
    })
}

pub fn crud_package() -> Package {
    register!(
        Package::builder("examples.crud"),
        create_item,
        get_item,
        list_items,
        update_item,
        delete_item
    )
    .build()
}
