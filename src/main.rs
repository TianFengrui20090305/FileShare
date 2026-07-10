use axum::{
    Router, body::Bytes, extract::DefaultBodyLimit, extract::State, http::HeaderMap, routing::post,
};
use config::{Config, File};
use futures_util::StreamExt;
use sha2::Digest;
use std::{
    collections::HashMap,
    error,
    path::Path,
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    fs, fs::OpenOptions, io::AsyncReadExt, io::AsyncWriteExt, process::Command, sync::mpsc,
};

#[cfg(debug_assertions)]
use tower_http::cors::CorsLayer;

#[cfg(not(debug_assertions))]
use include_dir::{Dir, include_dir};

#[cfg(not(debug_assertions))]
use mime_guess;

#[cfg(not(debug_assertions))]
static FRONTEND: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/frontend/dist");

pub struct ChunkMessage {
    file_hash: String,
    chunk_index: usize,
    total_chunks: usize,
}

#[derive(Clone)]
pub struct AppState {
    pub tx: mpsc::Sender<ChunkMessage>,
}

fn get_current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn error::Error>> {
    // Read config file
    let config = Config::builder()
        .add_source(File::with_name("Config"))
        .build()
        .expect("Unable to read Config.toml");
    let port: u16 = config.get("server.port").unwrap_or(114);
    let chunk_size_limit_mb: usize = config.get("upload.chunk_size_limit_mb").unwrap_or(50);
    let global_size_limit_mb: usize = config.get("upload.global_size_limit_mb").unwrap_or(10);
    let chunk_expire_hours: u64 = config.get("cleanup.chunk_expire_hours").unwrap_or(1);
    let gc_interval_seconds: u64 = config.get("cleanup.gc_interval_seconds").unwrap_or(30);
    let max_delete_concurrency: usize = config.get("cleanup.max_delete_concurrency").unwrap_or(4);
    println!("Read Config.toml Successfully! Port: {}", port);

    // Run ddns-go to rewrite AAAA record on cloudflare
    let mut _ddns_go = Command::new("./ddns-go/ddns-go.exe")
        .current_dir("./ddns-go")
        .arg("-c")
        .arg("./.ddns_go_config.yaml")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Unable to run ddns-go");
    println!("Run ddns-go Successfully! You can access http://localhost:9876 to configure.");

    let (tx, rx) = tokio::sync::mpsc::channel::<ChunkMessage>(100);
    let shared_state = AppState { tx };
    tokio::spawn(async move {
        if let Err(err) = tracker_worker(
            rx,
            chunk_expire_hours,
            gc_interval_seconds,
            max_delete_concurrency,
        )
        .await
        {
            println!("Tracker worker error: {}", err);
        }
    });

    let upload_router = Router::new()
        .route("/api/upload/chunk", post(upload_chunk))
        .layer(DefaultBodyLimit::max(chunk_size_limit_mb * 1024 * 1024));

    let app = Router::new()
        .merge(upload_router)
        .layer(DefaultBodyLimit::max(global_size_limit_mb * 1024 * 1024))
        .with_state(shared_state);

    // Release: serve embedded frontend
    #[cfg(not(debug_assertions))]
    let app = app.fallback(frontend_handler);

    // Debug: enable CORS for Vite dev server
    #[cfg(debug_assertions)]
    let app = app.layer(CorsLayer::permissive());

    let addr = format!("[::]:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    axum::serve(listener, app).await?;

    Ok(())
}

#[cfg(not(debug_assertions))]
async fn frontend_handler(uri: axum::http::Uri) -> impl axum::response::IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // Try to find the file in the embedded dist directory
    if let Some(file) = FRONTEND.get_file(path) {
        let mime = mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string();
        return axum::http::Response::builder()
            .status(200)
            .header("content-type", &mime)
            .body(axum::body::Body::from(file.contents().to_vec()))
            .unwrap();
    }

    // SPA fallback: serve index.html for unknown routes
    if let Some(file) = FRONTEND.get_file("index.html") {
        return axum::http::Response::builder()
            .status(200)
            .header("content-type", "text/html")
            .body(axum::body::Body::from(file.contents().to_vec()))
            .unwrap();
    }

    (axum::http::StatusCode::NOT_FOUND, "Not Found").into_response()
}

async fn upload_chunk(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> &'static str {
    // Read file info
    let Some(file_hash_raw) = headers.get("X-File-Hash").and_then(|v| v.to_str().ok()) else {
        return "Missing X-File-Hash";
    };
    let hash_bytes = sha2::Sha256::digest(file_hash_raw.as_bytes());
    let file_hash = hash_bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    let Some(total_chunks) = headers
        .get("X-Total-Chunks")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
    else {
        return "Missing X-Total-Chunks";
    };
    let chunk_index = headers
        .get("X-Chunk-Index")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    let file_path = format!("./uploads/{}_{}.part", file_hash, chunk_index);

    if chunk_index >= total_chunks {
        return "Out of total chunks";
    }

    // Start to save file
    if let Err(_) = tokio::fs::write(&file_path, body).await {
        return "Fail to save chunk file";
    }

    let msg = ChunkMessage {
        file_hash: String::from(file_hash),
        chunk_index,
        total_chunks,
    };
    if state.tx.send(msg).await.is_err() {
        return "Tracker worker is down";
    }

    "Chunk uploaded successfully"
}

async fn tracker_worker(
    mut rx: mpsc::Receiver<ChunkMessage>,
    chunk_expire_hours: u64,
    gc_interval_seconds: u64,
    max_delete_concurrency: usize,
) -> Result<(), Box<dyn error::Error>> {
    let expire_duration: u64 = chunk_expire_hours * 60 * 60;
    let mut tracker_map: HashMap<String, (Vec<usize>, u64)> = HashMap::new();
    let mut gc_timer = tokio::time::interval(tokio::time::Duration::from_secs(gc_interval_seconds));

    async fn merge_file(
        file_hash: &String,
        received: &Vec<usize>,
    ) -> Result<(), Box<dyn error::Error>> {
        let x1: &str = &file_hash[0..2];
        let x2 = &file_hash[2..4];
        let target_dir_str = format!("./files/{}/{}", x1, x2);
        let target_dir = Path::new(&target_dir_str);
        let mut target_path = target_dir.join(file_hash);
        let mut counter = 1;
        let mut buffer = vec![0u8; 65536];

        if !target_dir.exists() {
            fs::create_dir_all(target_dir).await?;
        }

        // Avoid Hash Boom
        while target_path.exists() {
            let new_name = format!("{}_{}", file_hash, counter);
            target_path = target_dir.join(new_name);
            counter += 1;
        }

        let mut target_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target_path)
            .await?;

        for index in received {
            let part_path = format!("./uploads/{}_{}.part", file_hash, index);

            if let Ok(mut part_file) = OpenOptions::new().read(true).open(&part_path).await {
                loop {
                    let n = part_file.read(&mut buffer).await?;
                    if n == 0 {
                        break;
                    }
                    target_file.write_all(&buffer[..n]).await?;
                }
            }
        }

        target_file.flush().await?;

        Ok(())
    }

    async fn remove_file(
        file_hash: &String,
        received: &Vec<usize>,
    ) -> Result<(), Box<dyn error::Error>> {
        for index in received {
            let part_path = format!("./uploads/{}_{}.part", file_hash, index);
            if fs::remove_file(&part_path).await.is_err() {
                println!("Unable to remove file. File chunk: {}", part_path);
            }
        }

        Ok(())
    }

    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                let now = get_current_timestamp();

                // Init Record
                let(received, last_update) = tracker_map.entry(msg.file_hash.clone()).or_insert_with(|| (Vec::new(), now));

                // Update chunk index and last update time
                if !received.contains(&msg.chunk_index) {
                    received.push(msg.chunk_index);
                }
                *last_update = now;

                // Merge file if full
                if received.len() == msg.total_chunks {
                    println!("Start to merge file. File hash: {}", msg.file_hash);
                    merge_file(&msg.file_hash, received).await?;
                    remove_file(&msg.file_hash, received).await?;
                    tracker_map.remove(&msg.file_hash);
                }
            }

            _ = gc_timer.tick() => {
                let now = get_current_timestamp();

                // Exact file hash and index of expired file
                let expired_files: Vec<(String, Vec<usize>)> = tracker_map
                    .extract_if(|_, (_, last_update)| now - *last_update > expire_duration)
                    .map(|(file_hash, (received, _))| (file_hash, received))
                    .collect();

                // Delete expired chunks
                tokio_stream::iter(expired_files)
                    .map(|(file_hash, received)| async move {
                        if let Err(err) = remove_file(&file_hash, &received).await {
                            println!("Expired file remove error: {}",err);
                        };
                    })
                    .buffered(max_delete_concurrency)
                    .collect::<Vec<()>>()
                    .await;
            }
        }
    }
}
