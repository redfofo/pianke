# 片刻

片刻是一个在浏览器里看剧的播放器网站。它从你自己的 **Happy Capy** 服务读取片源，提供分类浏览、搜索、选集播放、收藏和观看记录，手机、电脑、平板都能用，也可以用 Emby 客户端在电视上观看。

> 片刻本身不带任何片源，必须先有一个可以访问的 Happy Capy 服务。

## 功能一览

- 分类浏览、搜索、详情、分季选集，自动连播下一集
- 多账号：管理员给家人朋友建账号，每个人的收藏和观看进度互不干扰，换设备也能接着看
- 手机上支持手势拖动进度、长按倍速、横屏全屏，可以“添加到主屏幕”当 App 用
- 浅色、深色主题
- 兼容 Emby 客户端，可以在电视、机顶盒上观看

## 安装前准备

1. **一台长期开机的设备**：NAS、家用服务器、云服务器或一台 Linux 电脑都可以，支持 x86 (amd64) 和 ARM (arm64)。
2. **安装 Docker**：
   - 群晖、威联通、绿联、飞牛等 NAS：在套件中心安装 “Container Manager” 或 “Docker”。
   - Linux：参考 [Docker 官方安装文档](https://docs.docker.com/engine/install/)。
   - Windows / macOS：安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
3. **Happy Capy 的访问地址**：例如 `http://192.168.1.10:8788`（Happy Capy 默认端口是 8788）。这台设备必须能打开这个地址。

## 安装步骤

### 第 1 步：新建文件夹和配置文件

在设备上新建一个文件夹，比如 `pianke`，在里面新建一个名为 `docker-compose.yml` 的文件，把下面的内容完整复制进去：

```yaml
services:
  pianke:
    image: ghcr.io/redfofo/pianke:latest
    container_name: pianke
    restart: unless-stopped
    ports:
      - "8789:8789"
    environment:
      ADMIN_PASSWORD: ""   # 必填：管理员密码，10 到 128 个字符
    volumes:
      - ./pianke_data:/app/data
```

**一定要修改** `ADMIN_PASSWORD`，在引号里填上你的密码，例如 `ADMIN_PASSWORD: "MyPassw0rd2026"`。不填的话程序无法启动。

账号、收藏、观看记录和海报缓存都保存在同一文件夹下的 `pianke_data` 目录里，第一次启动时自动创建，更新或重建容器不会丢失。这个目录要放在本机硬盘上，不要放在 SMB/NFS 等网络共享盘里，否则数据库可能出错。

### 可选设置

需要时再加，不加也能正常使用。

**更换网页端口**：把 `"8789:8789"` 冒号左边的数字改掉，例如 `"9000:8789"`，然后用 `http://设备IP:9000` 访问。冒号右边不要改。

**更多环境变量**：加在 `environment:` 下面，和 `ADMIN_PASSWORD` 对齐：

| 变量 | 作用 |
| --- | --- |
| `ADMIN_USERNAME` | 管理员用户名，默认 `admin`。只在第一次启动时生效 |
| `CAPY_BACKEND_URL` | Happy Capy 地址，例如 `http://192.168.1.10:8788`。不填也行，启动后在网页“设置”里填写 |
| `SESSION_COOKIE_SECURE` | 通过 `https://` 域名访问时设为 `"true"` |
| `PUBLIC_BASE_URL` | 本机局域网地址，例如 `http://192.168.1.20:8789`，配合下面的 UDP 端口让 Emby 客户端自动发现 |

**Emby 客户端局域网自动发现**：在 `ports:` 下加一行 `- "7359:7359/udp"`，并设置 `PUBLIC_BASE_URL`。

加完之后的样子：

```yaml
    ports:
      - "8789:8789"
      - "7359:7359/udp"
    environment:
      ADMIN_PASSWORD: "MyPassw0rd2026"
      CAPY_BACKEND_URL: "http://192.168.1.10:8788"
      PUBLIC_BASE_URL: "http://192.168.1.20:8789"
```

### 第 2 步：启动

在这个文件夹里打开终端，运行：

```sh
docker compose up -d
```

第一次会下载镜像，需要等一会儿。NAS 用户也可以在 Container Manager 里选择“项目 → 新增”，选中这个文件夹，图形界面会自动读取 `docker-compose.yml`。

### 第 3 步：打开网页并完成设置

1. 浏览器打开 `http://设备IP:8789`，例如 `http://192.168.1.20:8789`。
2. 用 `admin` 和你刚才设置的密码登录。
3. 进入“设置”，填写 Happy Capy 地址并保存。
4. 回到首页，就能看到片源了。

## 日常使用

### 给家人朋友建账号

用管理员登录，进入“设置 → 管理账号”，填写用户名和初始密码，勾选允许观看的来源，保存即可。不开放自助注册。

### 在电视上用 Emby 客户端观看

在 Emby 客户端里添加服务器：

- 地址：`http://设备IP:8789`
- 用户名和密码：和网页登录用的一样

如果按[可选设置](#可选设置)开启了局域网自动发现，同一个局域网里的客户端通常能自动搜到“片刻”。

### 手机当 App 用

用手机浏览器打开网页，在浏览器菜单里选择“添加到主屏幕”。

## 常用命令

以下命令都在 `docker-compose.yml` 所在的文件夹里运行。

| 想做什么 | 命令 |
| --- | --- |
| 更新到最新版本 | `docker compose pull && docker compose up -d` |
| 查看运行日志 | `docker compose logs -f` |
| 重启 | `docker compose restart` |
| 停止 | `docker compose down` |

更新、重启、停止都**不会**丢失账号和观看记录。

**备份**：先 `docker compose down` 停止，复制整个 `pianke_data` 目录，再 `docker compose up -d` 启动。不要在运行时直接复制，可能得到不完整的数据库。迁移到新机器时，把 `docker-compose.yml` 和 `pianke_data` 一起复制过去即可。

### 固定在某个版本

镜像有两种标签：

- `latest`：始终是最新正式版
- 版本号，例如 `ghcr.io/redfofo/pianke:1.0.0`：固定在这个版本，不会自动变化

如果新版本有问题，可以把配置里的 `latest` 换成之前的版本号，再运行 `docker compose up -d` 回退。所有可用标签见 [GitHub Packages 页面](https://github.com/redfofo/pianke/pkgs/container/pianke)。

## 常见问题

**启动后马上退出，日志里有 `ADMIN_PASSWORD` 相关的报错**
没有填管理员密码，或者密码长度不在 10 到 128 个字符之间。改好 `docker-compose.yml` 后重新运行 `docker compose up -d`。

**网页打不开**
- 先用 `docker compose ps` 看容器是否在运行。
- 确认地址里的端口和配置里 `ports` 冒号左边的一致。
- 云服务器需要在防火墙或安全组里放行这个端口。

**忘记管理员密码**
修改 `ADMIN_PASSWORD` 不会重置已有的管理员密码。如果没有其他管理员账号，只能清空数据重新开始：`docker compose down` 停止后，删除 `pianke_data` 目录，再 `docker compose up -d`。这会删除所有账号和记录。

**首页没有内容 / 提示要设置上游**
管理员还没在“设置”里填写 Happy Capy 地址，或者这台设备访问不到那个地址。

**有声音没画面**
片源可能是 HEVC (H.265) 编码，当前浏览器不支持。可以换一个浏览器或设备，或者用 Emby 客户端播放并选择转码。

**8789 端口被占用**
见[可选设置](#可选设置)里的“更换网页端口”。

**想通过外网域名访问**
需要自己配置 HTTPS 反向代理（Nginx 示例见 [`deploy/nginx-location.conf`](deploy/nginx-location.conf)），并把 `SESSION_COOKIE_SECURE` 改成 `"true"`。只能部署在域名根路径，不支持 `/pianke/` 这类子路径。公网访问务必使用强密码。

## 从源码构建


```sh
git clone https://github.com/redfofo/pianke.git
cd pianke
cp .env.example .env   # 编辑 .env，填写 ADMIN_PASSWORD
docker compose up -d --build
```

## 发布新版本（维护者）

推送 `v` 开头的 git 标签就会自动构建并发布镜像，例如发布 1.0.1：

```sh
npm version 1.0.1 -m "Release %s"   # 更新 package.json 并创建 v1.0.1 标签
git push --follow-tags
```

镜像会打上 `1.0.1` 和 `latest` 两个标签。预发布版本（如 `v1.1.0-beta.1`）只打版本号标签，不更新 `latest`。平时推送到 `main` 不会发布镜像。

