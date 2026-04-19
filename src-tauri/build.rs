fn main() {
    let dist_path = std::path::Path::new("../dist");
    std::fs::create_dir_all(dist_path)
        .unwrap_or_else(|e| panic!("failed to create ../dist: {}", e));
    tauri_build::build()
}
