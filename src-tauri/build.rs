fn main() {
    let dist_path = std::path::Path::new("../dist");
    if !dist_path.exists() {
        std::fs::create_dir_all(dist_path).expect("failed to create ../dist");
    }
    tauri_build::build()
}
