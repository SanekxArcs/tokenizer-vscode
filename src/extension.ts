import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// B: Encoders are loaded lazily on first use so activation is fast and
//    only the chosen encoding pays the ~2–5 MB vocabulary load cost.
type EncodeFunc = (text: string) => number[];
const encoderCache = new Map<EncodingName, EncodeFunc>();

function getEncoder(enc: EncodingName): EncodeFunc {
  if (!encoderCache.has(enc)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(`gpt-tokenizer/cjs/encoding/${enc}`) as {
      encode: EncodeFunc;
    };
    encoderCache.set(enc, mod.encode);
  }
  return encoderCache.get(enc)!;
}

// Files too large to tokenize (>10 MB) are skipped to avoid hanging
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Binary-ish extensions we skip when walking folders
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".mov",
  ".avi",
  ".db",
  ".sqlite",
  ".bin",
  ".dat",
]);

type EncodingName = "cl100k_base" | "o200k_base" | "p50k_base";

const ENCODING_LABEL: Record<EncodingName, string> = {
  cl100k_base: "cl100k (GPT-4 / GPT-3.5)",
  o200k_base: "o200k (GPT-4o / o1 / o3 / GPT-5)",
  p50k_base: "p50k (GPT-3 / Codex)",
};

function getEncoding(): EncodingName {
  const val = vscode.workspace
    .getConfiguration("aiTokenCounter")
    .get<string>("encoding");
  if (val === "o200k_base" || val === "p50k_base") {
    return val;
  }
  return "cl100k_base";
}

function countTokens(text: string, encoding?: EncodingName): number {
  const enc = encoding ?? getEncoding();
  try {
    return getEncoder(enc)(text).length;
  } catch {
    // Fallback: rough character-based estimate (~4 chars per token)
    return Math.ceil(text.length / 4);
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

function getIgnoredFolders(): Set<string> {
  const config = vscode.workspace.getConfiguration("aiTokenCounter");
  const list: string[] = config.get("ignoredFolders") ?? [];
  return new Set(list);
}

// F: Parse the .gitignore in `dir` and return simple name-based rules.
//    Patterns containing a path separator in the middle are skipped (too
//    complex to resolve without a full gitignore library).
interface GitignoreRule {
  regex: RegExp;
  dirOnly: boolean;
}

function parseGitignore(dir: string): GitignoreRule[] {
  const gitignorePath = path.join(dir, ".gitignore");
  const rules: GitignoreRule[] = [];
  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    return rules;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue; // skip empty, comments, and negations (unsupported)
    }
    const dirOnly = line.endsWith("/");
    const p = line.replace(/\/$/, ""); // strip trailing slash
    // Skip patterns with internal slashes — they are path-specific
    if (p.includes("/")) {
      continue;
    }
    // Convert simple glob (* and ?) to a regex
    const regexStr = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials
      .replace(/\*/g, "[^/]*") // * → any chars except /
      .replace(/\?/g, "[^/]"); // ? → single char except /
    try {
      rules.push({ regex: new RegExp(`^${regexStr}$`), dirOnly });
    } catch {
      // Invalid pattern — skip
    }
  }
  return rules;
}

function matchesGitignore(name: string, rules: GitignoreRule[], isDir: boolean): boolean {
  return rules.some((r) => {
    if (r.dirOnly && !isDir) {
      return false;
    }
    return r.regex.test(name);
  });
}

function collectFiles(
  dir: string,
  ignoredFolders: Set<string>,
  gitignoreRules: GitignoreRule[],
): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const isDir = entry.isDirectory();
    // Skip hidden dirs, setting-based ignore list, and .gitignore rules
    if (
      entry.name.startsWith(".") ||
      ignoredFolders.has(entry.name) ||
      matchesGitignore(entry.name, gitignoreRules, isDir)
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (isDir) {
      results.push(...collectFiles(fullPath, ignoredFolders, gitignoreRules));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!SKIP_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

export function activate(context: vscode.ExtensionContext) {
  // ─── Status bar item ───────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "aiTokenCounter.countFolder";
  context.subscriptions.push(statusBar);

  // A: Debounce timer — avoids re-tokenizing on every single keystroke
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // G: Accept an optional selection; when non-empty, count only selected text
  function updateStatusBar(
    document: vscode.TextDocument | undefined,
    selection?: vscode.Selection,
  ) {
    if (!document || document.uri.scheme !== "file") {
      statusBar.hide();
      return;
    }
    const enc = getEncoding();
    const hasSelection = selection && !selection.isEmpty;
    const text = hasSelection ? document.getText(selection) : document.getText();
    const tokens = countTokens(text, enc);
    statusBar.text = hasSelection
      ? `$(symbol-numeric) ${formatCount(tokens)} selected`
      : `$(symbol-numeric) ${formatCount(tokens)} tokens`;
    statusBar.tooltip = hasSelection
      ? `${tokens.toLocaleString()} tokens in selection — ${ENCODING_LABEL[enc]}\nClick to count tokens in a folder`
      : `AI token count — ${ENCODING_LABEL[enc]}\nClick to count tokens in a folder`;
    statusBar.show();
  }

  function scheduleUpdate(
    document: vscode.TextDocument | undefined,
    selection?: vscode.Selection,
  ) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updateStatusBar(document, selection), 300);
  }

  // Update on active editor change (immediate — feels snappier on tab switch)
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      clearTimeout(debounceTimer);
      updateStatusBar(e?.document, e?.selection);
    }),
  );

  // G: Update on selection change (debounced)
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) {
        scheduleUpdate(e.textEditor.document, e.selections[0]);
      }
    }),
  );

  // Update on document edit (debounced — A)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        scheduleUpdate(e.document, vscode.window.activeTextEditor?.selection);
      }
    }),
  );

  // Re-render status bar when encoding setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiTokenCounter.encoding")) {
        clearTimeout(debounceTimer);
        updateStatusBar(
          vscode.window.activeTextEditor?.document,
          vscode.window.activeTextEditor?.selection,
        );
      }
    }),
  );

  // Initial update
  updateStatusBar(
    vscode.window.activeTextEditor?.document,
    vscode.window.activeTextEditor?.selection,
  );

  // ─── Command: count current file ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("aiTokenCounter.countCurrentFile", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) {
        vscode.window.showWarningMessage("AI Token Counter: No file is open.");
        return;
      }
      const tokens = countTokens(doc.getText());
      vscode.window.showInformationMessage(
        `AI Token Counter: ${tokens.toLocaleString()} tokens in "${path.basename(doc.fileName)}"`,
      );
    }),
  );

  // ─── Command: manage ignored folders ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "aiTokenCounter.manageIgnoredFolders",
      async () => {
        const config = vscode.workspace.getConfiguration("aiTokenCounter");
        const current: string[] = config.get("ignoredFolders") ?? [];

        const options = [
          { label: "$(add) Add a folder name to ignore list", id: "add" },
          {
            label: "$(trash) Remove a folder name from ignore list",
            id: "remove",
          },
          { label: "$(list-unordered) Show current ignore list", id: "show" },
        ] as const;

        const picked = await vscode.window.showQuickPick(
          options.map((o) => o.label),
          {
            title: "AI Token Counter — Ignored Folders",
            placeHolder: "What do you want to do?",
          },
        );

        if (!picked) {
          return;
        }

        const action = options.find((o) => o.label === picked)?.id;

        if (action === "add") {
          const name = await vscode.window.showInputBox({
            title: "Add folder to ignore list",
            prompt:
              "Enter the folder name to ignore (e.g. dist, build, coverage)",
            validateInput: (v) =>
              v.trim().length === 0 ? "Folder name cannot be empty" : undefined,
          });
          if (!name) {
            return;
          }
          const trimmed = name.trim();
          if (current.includes(trimmed)) {
            vscode.window.showInformationMessage(
              `"${trimmed}" is already in the ignore list.`,
            );
            return;
          }
          await config.update(
            "ignoredFolders",
            [...current, trimmed],
            vscode.ConfigurationTarget.Global,
          );
          vscode.window.showInformationMessage(
            `Added "${trimmed}" to the ignore list.`,
          );
        } else if (action === "remove") {
          if (current.length === 0) {
            vscode.window.showInformationMessage(
              "The ignore list is already empty.",
            );
            return;
          }
          const toRemove = await vscode.window.showQuickPick(current, {
            title: "Remove from ignore list",
            placeHolder: "Select a folder name to remove",
            canPickMany: true,
          });
          if (!toRemove || toRemove.length === 0) {
            return;
          }
          const updated = current.filter((f) => !toRemove.includes(f));
          await config.update(
            "ignoredFolders",
            updated,
            vscode.ConfigurationTarget.Global,
          );
          vscode.window.showInformationMessage(
            `Removed: ${toRemove.map((f) => `"${f}"`).join(", ")} from the ignore list.`,
          );
        } else if (action === "show") {
          if (current.length === 0) {
            vscode.window.showInformationMessage("Ignore list is empty.");
          } else {
            vscode.window.showInformationMessage(
              `Ignored folders (${current.length}): ${current.join(", ")}`,
            );
          }
        }
      },
    ),
  );

  // ─── Command: count folder ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("aiTokenCounter.countFolder", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Count tokens in this folder",
        title: "Select folder to count AI tokens",
      });

      if (!uris || uris.length === 0) {
        return;
      }

      const folderPath = uris[0].fsPath;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "AI Token Counter: Scanning folder…",
          cancellable: true,
        },
        async (progress, token) => {
          const ignoredFolders = getIgnoredFolders();
          const enc = getEncoding();
          // F: Read and parse .gitignore from the scanned folder root
          const gitignoreRules = parseGitignore(folderPath);
          const files = collectFiles(folderPath, ignoredFolders, gitignoreRules);
          const results: Array<{ file: string; tokens: number }> = [];
          let processed = 0;

          for (const file of files) {
            if (token.isCancellationRequested) {
              break;
            }

            processed++;
            progress.report({
              message: `${processed}/${files.length} files`,
              increment: (1 / files.length) * 100,
            });

            try {
              const stat = fs.statSync(file);
              if (stat.size > MAX_FILE_BYTES) {
                results.push({ file, tokens: -1 }); // mark as skipped
                continue;
              }
              const content = fs.readFileSync(file, "utf8");
              results.push({ file, tokens: countTokens(content, enc) });
            } catch {
              // Unreadable file — skip silently
            }
          }

          showFolderResults(
            folderPath,
            results,
            enc,
            token.isCancellationRequested,
          );
        },
      );
    }),
  );
}

// C: Reuse an existing results panel instead of accumulating new ones
let folderResultsPanel: vscode.WebviewPanel | undefined;

function showFolderResults(
  folderPath: string,
  results: Array<{ file: string; tokens: number }>,
  encoding: EncodingName,
  cancelled: boolean,
) {
  if (folderResultsPanel) {
    try {
      folderResultsPanel.reveal(vscode.ViewColumn.One, true);
    } catch {
      // Panel was disposed externally
      folderResultsPanel = undefined;
    }
  }
  if (!folderResultsPanel) {
    folderResultsPanel = vscode.window.createWebviewPanel(
      "aiTokenCounterResults",
      "Token Count Results",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      { enableScripts: false },
    );
    folderResultsPanel.onDidDispose(() => {
      folderResultsPanel = undefined;
    });
  }

  const totalTokens = results.reduce(
    (sum, r) => sum + (r.tokens > 0 ? r.tokens : 0),
    0,
  );

  const rows = results
    .sort((a, b) => b.tokens - a.tokens)
    .map((r) => {
      const rel = path.relative(folderPath, r.file);
      const display =
        r.tokens < 0
          ? `<span style="color:#888">skipped (>10 MB)</span>`
          : r.tokens.toLocaleString();
      return `<tr>
        <td style="padding:4px 12px 4px 0;font-family:monospace;font-size:13px">${escapeHtml(rel)}</td>
        <td style="padding:4px 0;text-align:right;font-family:monospace;font-size:13px">${display}</td>
      </tr>`;
    })
    .join("\n");

  const cancelledNote = cancelled
    ? `<p style="color:orange">⚠ Scan was cancelled — results are partial.</p>`
    : "";

  folderResultsPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Token Count Results</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
  h2 { margin-top: 0; }
  .summary { font-size: 1.2em; margin-bottom: 16px; }
  .total { font-weight: bold; color: var(--vscode-textLink-foreground); }
  table { border-collapse: collapse; width: 100%; }
  tr:nth-child(even) { background: var(--vscode-list-hoverBackground); }
  th { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--vscode-editorGroup-border); }
  .path-col { width: 80%; }
  .note { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 16px; }
</style>
</head>
<body>
<h2>AI Token Count — ${escapeHtml(path.basename(folderPath))}</h2>
${cancelledNote}
<div class="summary">
  Total: <span class="total">${totalTokens.toLocaleString()} tokens</span>
  &nbsp;·&nbsp; ${results.length} file(s) scanned
</div>
<table>
  <thead>
    <tr>
      <th class="path-col">File</th>
      <th style="text-align:right">Tokens</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
<p class="note">
  Encoding: <strong>${escapeHtml(encoding)}</strong> — ${escapeHtml(ENCODING_LABEL[encoding])}.
  Actual counts may vary ±5–20 % depending on the AI provider and model.
</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function deactivate() {}
