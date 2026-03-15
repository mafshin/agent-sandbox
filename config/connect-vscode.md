# Connecting Local VS Code to Agent Sandbox

The sandbox runs **code-server** — a browser-hosted VS Code. You have two ways to use it from your local machine.

---

## Option A — Browser (no setup needed)

Open in your browser:

```
http://localhost:8080/editor/
```

This is the full VS Code experience in the browser. Use this URL for quick edits or when working remotely.

---

## Option B — Local VS Code via Dev Containers (recommended)

Connect your **installed VS Code** directly to the running container. This gives you:
- Full native VS Code (extensions, themes, keybindings from your local install)
- Direct access to `/workspace` inside the container
- Terminal, debugger, and all local VS Code features

### Steps

1. Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) in local VS Code.

2. Start the sandbox container (if not already running):
   ```bash
   docker run -d --name agent-sandbox -p 8080:8080 --shm-size=2gb --security-opt seccomp:unconfined agent-sandbox:dev
   ```

3. In local VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:
   ```
   Dev Containers: Attach to Running Container...
   ```

4. Select **agent-sandbox** from the list.

5. VS Code opens a new window connected to `/workspace` inside the container.

### Tips

- The workspace files at `/workspace` are the same files you see in the browser editor.
- You can install extensions inside the container — they persist across restarts only if you mount a volume.
- To open a specific folder: after attaching, use `File → Open Folder` and navigate to `/workspace`.

---

## Option C — Remote SSH (advanced)

The container does not include an SSH server by default. To use Remote SSH:

1. Add `openssh-server` to the Dockerfile and expose port 22.
2. Configure SSH keys for the `agent` user.
3. Use VS Code Remote SSH to connect.

This is not recommended for most use cases — Dev Containers (Option B) is simpler.
