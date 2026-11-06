# Mac Node Setup Guide (M4 / M5 MacBook Air)

This guide turns each MacBook Air into a GPU node for the Campus GPU Pool. Every command runs on the **Mac** unless it says otherwise.

| Machine | Wired IP | Role |
|---|---|---|
| Host (Linux, RTX 4060) | `10.73.185.71` | Runs `llama-server`; holds the model files |
| M5 Air 16 GB | fill in | RPC worker / capacity node |
| M4 Air 16 GB | fill in | RPC worker / capacity node |

- **llama.cpp build:** b12125. Every machine must use **exactly this build**, because RPC has no version check.
- **Time needed:** about 20 minutes per Mac.

---

## 1. Hardware and power

1. Plug a **USB-C to Ethernet adapter** into the Mac and a cable from it to the hub.
2. **Turn Wi-Fi off** (Control Center → Wi-Fi off). Otherwise traffic may take the slow path.
3. **Plug in the charger.** On battery the Mac slows itself down.
4. Turn **Low Power Mode off**: System Settings → Battery → Low Power Mode → **Never**.
5. Put the Mac on a **hard, flat surface**, not a bed or lap. The Air has no fan, so it relies on air around the case to cool down.
6. Quit heavy apps: browsers with many tabs, Docker, Slack, IDEs. On a 16 GB Mac, every GB matters.

---

## 2. Find the wired IP and check the network

Open **Terminal** (Cmd+Space → "Terminal").

```bash
# List network interfaces; the USB adapter is usually en5..en9
networksetup -listallhardwareports

# Show the IP of the adapter (replace en7 with the one listed as "USB 10/100/1000 LAN")
ipconfig getifaddr en7
```

- The IP **must start with `10.73.`**. Write it in the table at the top of this guide.
- If nothing prints, the adapter has no address yet. Unplug and replug the cable, and check System Settings → Network.

Check you can reach the host laptop:
```bash
ping -c 20 10.73.185.71
```
- **Expected:** 0% packet loss and an average around 1–2 ms.
- **If it shows "Request timeout":** check the cable and that Wi-Fi is off.

Check the adapter's link speed:
```bash
ifconfig en7 | grep media
```
- **Expected:** `1000baseT`.
- **If it shows `100baseTX`:** the cable or adapter is limiting you to 100 Mbps. Swap the cable, or try another port.

---

## 3. Download llama.cpp b12125

```bash
mkdir -p ~/gpupool && cd ~/gpupool
curl -L -o llama.tar.gz \
  https://github.com/ggml-org/llama.cpp/releases/download/b12125/llama-b12125-bin-macos-arm64.tar.gz
tar -xzf llama.tar.gz && rm llama.tar.gz
ls
```
You will see a folder, most likely `llama-b12125`. Go into the folder that contains `llama-server`:
```bash
cd ~/gpupool/llama-b12125   # adjust if the folder name differs
ls | grep -E "llama-server|rpc-server|llama-bench"
```
**Expected:** `llama-server`, `ggml-rpc-server` and `llama-bench`.

### Remove the macOS quarantine flag
macOS blocks programs downloaded from the internet that aren't signed ("cannot be opened because the developer cannot be verified"). Remove the flag on the whole folder:
```bash
xattr -dr com.apple.quarantine ~/gpupool
```

### Check that the GPU is visible
```bash
./llama-bench --list-devices
```
**Expected:** a line like
```
MTL0: Apple M5 (10922 MiB, 10922 MiB free)
```
The number in brackets is how much memory the GPU may use. On a 16 GB Mac it is about 10.6–11 GB by default.

---

## 4. Optional: allow the GPU a bit more memory

By default macOS lets the GPU use about two-thirds of RAM. You can raise this a little, but **leave at least 4.5 GB for macOS**, or the Mac will start swapping to disk and get very slow.

```bash
# 16 GB Mac: allow the GPU 11.5 GB. Resets on reboot.
sudo sysctl iogpu.wired_limit_mb=11776

# Check:
./llama-bench --list-devices
```
- Only do this if the 32B split needs it. Start with the default.
- **To undo:** `sudo sysctl iogpu.wired_limit_mb=0`, or reboot.

---

## 5. Stop the Mac from sleeping during tests

Open a **second Terminal tab** (Cmd+T) and leave this running:
```bash
caffeinate -dimsu
```
Press Ctrl+C when you are done testing.

---

## 6. Run as an RPC worker (for the unified GPU)

In this mode the Mac lends its GPU to the host. The host sends the Mac its share of the model over the network, so **the Mac does not need the model file**.

```bash
cd ~/gpupool/llama-b12125
./ggml-rpc-server -H <THIS-MAC-WIRED-IP> -p 50052 -c
```
- `-H <IP>` listens only on the wired network. **Never use `0.0.0.0`.**
- `-c` saves the received model pieces to disk, so the second load is fast. Cache location: `~/Library/Caches/llama.cpp/rpc/` or `~/.cache/llama.cpp/rpc/`. A 32B share can use several GB of disk.

**Expected output:** the Metal device with its free memory, then a line saying it is listening on port 50052. Leave it running.

### macOS firewall
If a popup asks *"Do you want the application ggml-rpc-server to accept incoming network connections?"*, click **Allow**.

If nothing pops up but the host can't connect, check System Settings → Network → Firewall:
- If it's on, click **Options** and add `ggml-rpc-server` with **Allow incoming connections**.
- Or turn the firewall off just for the test, and back on afterwards.

### Security warning
`ggml-rpc-server` accepts commands from **anyone** who can reach port 50052. The venue network is shared with every attendee, so:
- Run it **only during tests**, and stop it with Ctrl+C right after.
- Bind it only to the wired IP (`-H`), as above.

### On the HOST (Linux laptop), not the Mac
```bash
cd ~/gpupool-tools/llama-b12125/llama-b12125 && export LD_LIBRARY_PATH=.

# T2a: 14B model, 4060 + M5
./llama-server -m ~/models/Qwen2.5-14B-Instruct-Q4_K_M.gguf -ngl 99 \
  --rpc <M5-IP>:50052 --host 127.0.0.1 --port 8080

# T2b: 32B model, 4060 + M5 + M4
./llama-server -m ~/models/Qwen2.5-32B-Instruct-Q4_K_M.gguf -ngl 99 \
  --rpc <M5-IP>:50052,<M4-IP>:50052 --host 127.0.0.1 --port 8080
```
- **First load is slow:** the Mac receives several GB over the network, which takes 1–3 minutes.
- **Second load** comes from the `-c` cache and is fast.

---

## 7. Run as a capacity node (whole small model on the Mac)

In this mode the Mac runs a whole 7B model by itself. It needs the model file, so copy it from the host.

**On the HOST** (shares the `~/models` folder on the wired network only):
```bash
cd ~/models && python3 -m http.server 8000 --bind 10.73.185.71
```

**On the Mac:**
```bash
mkdir -p ~/models && cd ~/models
curl -O http://10.73.185.71:8000/Qwen2.5-7B-Instruct-Q4_K_M.gguf
shasum -a 256 Qwen2.5-7B-Instruct-Q4_K_M.gguf     # must match the host's sha256sum
```

Benchmark it:
```bash
cd ~/gpupool/llama-b12125
./llama-bench -m ~/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf -ngl 99
```
Note the `tg128` number (tokens per second when generating). Expect roughly **20–25 on M5** and **15–20 on M4**.

Serve it on the wired network:
```bash
./llama-server -m ~/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf -ngl 99 \
  --host <THIS-MAC-WIRED-IP> --port 8080
```
Test it from the host:
```bash
curl http://<MAC-IP>:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hi in 5 words"}]}'
```

**On the HOST**, stop the file server (Ctrl+C) once both Macs have the file.

---

## 8. Watch heat and memory during tests

The Air has no fan, so it **slows down as it heats up**. Always measure over **5 minutes**, not 30 seconds.

- **Activity Monitor → Window → GPU History**: GPU load.
- **Activity Monitor → Memory tab → Memory Pressure graph**: must stay **green**. Yellow or red means swapping, so reduce this Mac's share.
- **Temperature and throttling** (needs your password):
  ```bash
  sudo powermetrics --samplers thermal,gpu_power -i 5000
  ```
  - If "pressure level" goes from `Nominal` to `Moderate` or `Heavy`, the Mac is slowing down because of heat.

For each test, record:

| Test | Mac | Load time (first / cached) | tok/s at 30 s | tok/s at 5 min | Memory pressure | Thermal level |
|---|---|---|---|---|---|---|
| | | | | | | |

---

## 9. When done

1. Ctrl+C on `ggml-rpc-server` and `llama-server`.
2. Ctrl+C on `caffeinate`.
3. If you raised the GPU memory limit: `sudo sysctl iogpu.wired_limit_mb=0`.
4. Turn the firewall back on if you turned it off.
5. Optional: clear the RPC cache to free disk space: `rm -rf ~/Library/Caches/llama.cpp/rpc ~/.cache/llama.cpp/rpc`

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "cannot be opened because the developer cannot be verified" | `xattr -dr com.apple.quarantine ~/gpupool` |
| `--list-devices` shows no Metal device | Wrong download. It must be `macos-arm64`, not `macos-x64` |
| Host says "failed to connect to RPC server" | Check the Mac IP, that `ggml-rpc-server` is running, the firewall popup, and that the host can `ping` the Mac |
| Host crashes or errors right after connecting | The builds don't match. Both must be b12125 |
| Very slow, and memory pressure is red | The Mac's share is too big. Give the host more layers, or use 14B instead of 32B |
| Speed drops after a few minutes | Heat slowdown. Cool surface, plugged in, Low Power Mode off |
| Link speed shows `100baseTX` | Bad cable or adapter port. Swap the cable |
