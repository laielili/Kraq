// Electron 壳（一键自动封装交付）：一份 .exe 交付，前端静态页面由 Electron 加载，
// 后端 Python（修改后的 main.py，托管 dist/ 静态站 + 提供 /api）作为子进程运行
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

// 配置：后端服务端口（与 main.py 中 BACKEND_PORT 一致，默认为 8000）
const BACKEND_PORT = process.env.BACKEND_PORT || '8000';
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

let pythonProc = null;

function getBackendCommand() {
  if (app.isPackaged) {
    // 打包后：使用打包好的 kraq.exe（位于 resources/ 目录）
    // portable 模式下 resources 在 process.resourcesPath
    const backendPath = path.join(process.resourcesPath, 'kraq.exe');
    return { cmd: backendPath, args: [], cwd: path.dirname(backendPath) };
  } else {
    // 开发环境：直接运行 Python 源码
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const scriptPath = path.join(__dirname, '..', 'build', 'static_server.py');
    return { cmd: pythonCmd, args: [scriptPath], cwd: path.resolve(__dirname, '..') };
  }
}

function startPythonBackend() {
  const { cmd, args, cwd } = getBackendCommand();
  console.log('[Electron] 启动 Python 后端:', cmd, args);

  pythonProc = spawn(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, BACKEND_PORT, FRONTEND_PORT: '0' },
  });

  pythonProc.on('error', (err) => {
    console.error('[Electron] Python 启动失败:', err);
  });

  pythonProc.on('close', (code) => {
    console.log(`[Electron] Python 进程退出，退出码: ${code}`);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 加载由 Python 托管的静态前端（dist/index.html 由 FastAPI StaticFiles 提供）
  // 若 Python 尚未就绪，Electron 会短暂显示空白；实际部署可增加重试逻辑
  win.loadURL(BACKEND_URL);

  win.on('closed', () => {
    if (pythonProc && !pythonProc.killed) {
      console.log('[Electron] 关闭窗口，终止 Python 子进程');
      pythonProc.kill();
    }
  });
}

app.whenReady().then(() => {
  // 先启动 Python 后端（确保静态站可用后再加载页面）
  startPythonBackend();

  // 短暂延迟确保后端启动（实际可用健康检查 /api/health 轮询替代）
  setTimeout(() => {
    createWindow();
  }, 1500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (pythonProc && !pythonProc.killed) {
    pythonProc.kill();
  }
  if (process.platform !== 'darwin') app.quit();
});
