# 部署面板

当前个人 fork 只保留本地二进制包 + systemd 部署方式。

## 本地 systemd 一键部署

以 root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/Su-cyber-art/Forwardx/main/scripts/install-panel-local.sh | FORWARDX_GITHUB_REPO=Su-cyber-art/Forwardx bash -s -- install
```

安装完成后访问：

```text
http://服务器IP:3000
```

第一次打开面板时不会直接进入后台，而是进入初始化向导。你需要先选择数据库，再创建管理员账号。

常用命令：

```bash
# 升级面板
curl -fsSL https://raw.githubusercontent.com/Su-cyber-art/Forwardx/main/scripts/install-panel-local.sh | FORWARDX_GITHUB_REPO=Su-cyber-art/Forwardx bash -s -- upgrade

# 指定版本升级
curl -fsSL https://raw.githubusercontent.com/Su-cyber-art/Forwardx/main/scripts/install-panel-local.sh | FORWARDX_GITHUB_REPO=Su-cyber-art/Forwardx FORWARDX_TARGET_VERSION=vX.Y.Z bash -s -- upgrade

# 卸载面板
curl -fsSL https://raw.githubusercontent.com/Su-cyber-art/Forwardx/main/scripts/install-panel-local.sh | FORWARDX_GITHUB_REPO=Su-cyber-art/Forwardx bash -s -- uninstall

# 查看面板日志
journalctl -u forwardx-panel -n 300 --no-pager
```

默认安装目录通常是：

```text
/opt/forwardx-panel
```

如需卸载本地面板，请先阅读 [卸载 ForwardX](./uninstall.md)，确认是否保留安装目录和数据库。

## 本地 systemd 手动部署

本地手动部署适合不想执行一键脚本的用户。建议直接使用当前 fork GitHub Release 中的面板安装包，不建议普通用户在服务器上从源码编译。

### 1. 准备 Node.js 和 pnpm

ForwardX 面板需要 Node.js 22 或以上版本。

Ubuntu/Debian 示例：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs curl tar gzip
corepack enable
corepack prepare pnpm@10.28.1 --activate
node -v
pnpm -v
```

如果你使用 CentOS、AlmaLinux、Rocky Linux、Debian 旧版本或其他系统，只要最终 `node -v` 是 22 或以上，`pnpm -v` 能正常输出即可。

### 2. 下载面板安装包

把 `VERSION` 改成 GitHub Releases 中的最新版本号：

```bash
VERSION=v2.3.188
mkdir -p /opt/forwardx-panel
cd /opt/forwardx-panel
curl -fL "https://github.com/Su-cyber-art/Forwardx/releases/download/${VERSION}/forwardx-panel-${VERSION}.tar.gz" -o /tmp/forwardx-panel.tar.gz
tar -xzf /tmp/forwardx-panel.tar.gz -C /opt/forwardx-panel
```

如果安装包内包含依赖补丁目录，保持 `patches` 目录和 `package.json` 在同一安装目录下。

### 3. 安装运行依赖

```bash
cd /opt/forwardx-panel
pnpm install --prod --frozen-lockfile
```

### 4. 写入环境变量

```bash
cat > /opt/forwardx-panel/.env <<'EOF'
NODE_ENV=production
PORT=3000
JWT_SECRET=请替换为随机字符串
DATABASE_CONFIG_PATH=/opt/forwardx-panel/data/database.json
SQLITE_PATH=/opt/forwardx-panel/data/forwardx.db
FORWARDX_PORT_CONFIG_PATH=/opt/forwardx-panel/.env
FORWARDX_PORT_MANAGEMENT=local
FORWARDX_UPGRADE_COMMAND=/bin/bash /opt/forwardx-panel/scripts/install-panel-local.sh upgrade
EOF
```

更多环境变量见 [环境变量](./env-vars.md)。

### 5. 写入 systemd 服务

```bash
cat > /etc/systemd/system/forwardx-panel.service <<'EOF'
[Unit]
Description=ForwardX Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/forwardx-panel
EnvironmentFile=/opt/forwardx-panel/.env
ExecStart=/usr/bin/node /opt/forwardx-panel/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now forwardx-panel
systemctl status forwardx-panel --no-pager
```

## 配置域名和 HTTPS

建议使用 Nginx、Caddy 或宝塔反向代理到面板端口。

Nginx 示例：

```nginx
server {
    listen 80;
    server_name panel.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

配置 HTTPS 后，面板公开地址建议填写：

```text
https://panel.example.com
```

## 首次进入面板

部署完成后，浏览器打开面板地址会进入首次初始化页面。

初始化流程：

1. 选择数据库：SQLite、MySQL 或 PostgreSQL。
2. 如果选择 MySQL/PostgreSQL，填写地址、端口、数据库名、用户名、密码和 SSL 开关。
3. 点击保存连接，系统会先测试数据库是否能连接。
4. 创建第一个管理员账号。
5. 登录后台后，在系统设置里填写面板公开地址。

数据库选择建议：

| 数据库 | 适合情况 |
| --- | --- |
| SQLite | 第一次使用、单机、小规模规则，最省心 |
| MySQL | 长期使用、多用户、已有 MySQL 环境 |
| PostgreSQL | 已有 PostgreSQL 环境，或希望使用 PostgreSQL 管理数据 |

更完整的初始化说明可以看 [首次初始化](./first-setup.md)。
