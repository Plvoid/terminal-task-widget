# terminal-task-widget

桌面小组件，基于 Tauri 2.0 + React + TypeScript + Vite。

## 技术栈

- **Backend**: Rust (Tauri 2.0)
- **Frontend**: React 19 + TypeScript + Vite 7
- **Styling**: Tailwind CSS v4

## 目录结构

```
terminal-task-widget/
├── src/              # 前端代码 (React)
├── src-tauri/        # Rust 后端代码
├── public/           # 静态资源
├── dist/             # 前端构建产物 (Vite)
└── ...
```

## 常用命令

```bash
# 开发（同时启动 Vite + Tauri）
npm run tauri dev

# 仅前端开发
npm run dev

# 构建（生产）
npm run tauri build

# 仅前端构建
npm run build
```

## 开发规范

- 默认中文沟通，代码、命令、变量名用英文。
- 引入第三方依赖库前必须说明必要性，简单工具函数直接手写。
- 密钥、token、密码不进代码、不进 commit、不进日志。
