use anyhow::{Context, Result};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::thread;

use super::index::IncrementalIndex;

pub struct WatcherDaemon {
    pub repo_root: PathBuf,
    pub index: Arc<RwLock<IncrementalIndex>>,
    _watcher: RecommendedWatcher,
}

impl WatcherDaemon {
    pub fn start<P: AsRef<Path>>(repo_root: P) -> Result<Self> {
        let root = dunce::canonicalize(repo_root.as_ref())
            .context("Failed to canonicalize path for WatcherDaemon")?;

        let index = Arc::new(RwLock::new(IncrementalIndex::new()));

        // Perform initial fast scan
        {
            let mut idx = index.write().unwrap();
            let _ = idx.initial_scan(&root);
        }

        let (tx, rx) = crossbeam_channel::unbounded::<notify::Result<Event>>();

        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        )?;

        watcher.watch(&root, RecursiveMode::Recursive)?;

        let worker_root = root.clone();
        let worker_index = Arc::clone(&index);

        thread::spawn(move || {
            while let Ok(event_res) = rx.recv() {
                if let Ok(event) = event_res {
                    Self::process_event(&worker_root, &worker_index, event);
                }
            }
        });

        Ok(Self {
            repo_root: root,
            index,
            _watcher: watcher,
        })
    }

    fn process_event(root: &Path, index: &Arc<RwLock<IncrementalIndex>>, event: Event) {
        for path in event.paths {
            let path_str = path.to_string_lossy();
            if path_str.contains("/.git/") || path_str.contains("/node_modules/") || path_str.contains("/target/") {
                continue;
            }

            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    let mut idx = index.write().unwrap();
                    let _ = idx.update_file(root, &path);
                }
                EventKind::Remove(_) => {
                    let mut idx = index.write().unwrap();
                    idx.remove_file(root, &path);
                }
                _ => {}
            }
        }
    }
}
