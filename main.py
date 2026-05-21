import threading
import time
import socket
import sys
import uvicorn
import webview
from app import app as fastapi_app

def get_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("", 0))
    s.listen(1)
    port = s.getsockname()[1]
    s.close()
    return port

def cleanup_old_install():
    try:
        import os
        import shutil
        current_binary = os.path.abspath(sys.argv[0])
        if ".app/Contents/MacOS/" in current_binary:
            app_dir = current_binary.split(".app/Contents/MacOS/")[0] + ".app"
            old_app_dir = app_dir + ".old"
            if os.path.exists(old_app_dir):
                time.sleep(2)  # Give the old process a moment to exit
                shutil.rmtree(old_app_dir)
    except Exception:
        pass

def run_server(port):
    # Run Uvicorn in the background thread
    uvicorn.run(fastapi_app, host="127.0.0.1", port=port, log_level="error", loop="asyncio")

def main():
    # Start background cleanup thread for previous bundle upgrades
    threading.Thread(target=cleanup_old_install, daemon=True).start()
    
    port = get_free_port()
    
    server_thread = threading.Thread(target=run_server, args=(port,), daemon=True)
    server_thread.start()
    
    # Wait for the FastAPI server to start up (up to 60 seconds)
    start_time = time.time()
    server_ready = False
    while time.time() - start_time < 60:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.1)
                s.connect(("127.0.0.1", port))
                server_ready = True
                break
        except Exception:
            time.sleep(0.1)
            
    if not server_ready:
        print("Error: FastAPI server failed to start in time.")
        sys.exit(1)
    
    # Create the native window
    webview.create_window(
        "Ninox DB Diagnostics",
        f"http://127.0.0.1:{port}",
        width=1200,
        height=800,
        min_size=(900, 600),
        background_color="#0a0e17"
    )
    
    webview.start()

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    main()
