fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let probe = "src/local_network.m";
        println!("cargo:rerun-if-changed={probe}");
        cc::Build::new()
            .file(probe)
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("soluna_local_network");
        println!("cargo:rustc-link-lib=framework=Network");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=dylib=objc");
        let manifest = "resources/host/soluna-host.zip.json";
        println!("cargo:rerun-if-changed={manifest}");
        let bytes = match std::fs::read(manifest) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("Cannot read Sunshine archive manifest: {error}"),
        };
        if let Some(bytes) = bytes {
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).expect("Invalid Sunshine archive manifest");
            for (field, variable, length) in [
                ("sha256", "SOLUNA_MAC_HOST_ARCHIVE_SHA256", 64),
                ("cdhash", "SOLUNA_MAC_HOST_CDHASH", 40),
            ] {
                let hash = value[field].as_str().expect("Missing Sunshine hash");
                assert!(
                    hash.len() == length && hash.bytes().all(|b| b.is_ascii_hexdigit()),
                    "Invalid Sunshine hash"
                );
                println!("cargo:rustc-env={variable}={hash}");
            }
        }
    }
    tauri_build::build();
}
