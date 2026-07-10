use std::process::Command;

fn main() {
    // Only build frontend for release (production binary)
    if std::env::var("PROFILE").unwrap_or_default() == "release" {
        println!("Building frontend for release...");
        let status = Command::new("cmd")
            .args(["/C", "cd frontend && set VITE_API_URL= && npm run build"])
            .status()
            .expect("Failed to run npm build");
        assert!(
            status.success(),
            "Frontend build failed. Run `cd frontend && npm install` first."
        );
    }

    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/public");
    println!("cargo:rerun-if-changed=frontend/package.json");
    println!("cargo:rerun-if-changed=frontend/vite.config.ts");
    println!("cargo:rerun-if-changed=frontend/index.html");
}
