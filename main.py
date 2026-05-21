import threading
import time
import socket
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

def run_server(port):
    # Run Uvicorn in the background thread
    uvicorn.run(fastapi_app, host="127.0.0.1", port=port, log_level="error", loop="asyncio")

def main():
    port = get_free_port()
    
    server_thread = threading.Thread(target=run_server, args=(port,), daemon=True)
    server_thread.start()
    
    # Give the server a moment to start
    time.sleep(1)
    
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
    main()
