# -*- coding: utf-8 -*-
"""提交前检查：暂存区里的文本文件必须是合法 UTF-8。

为什么需要它：这台机器装了亿赛通透明加密，某些进程（如 Python）写 .md 等文档时
落盘的是密文，而 git.exe 不在解密白名单里，会把密文原样提交，GitHub 就渲染不出 README。
这个脚本让这种污染在 commit 阶段直接失败。
"""
import subprocess
import sys

TEXT_EXT = {
    ".md", ".txt", ".py", ".js", ".css", ".html", ".json", ".bat",
    ".sh", ".yml", ".yaml", ".ini", ".cfg", ".toml", ".gitignore", ".gitattributes",
}


def git(*args, binary=False):
    out = subprocess.run(["git", *args], capture_output=True)
    return out.stdout if binary else out.stdout.decode("utf-8", "replace")


def main():
    names = [f for f in git("diff", "--cached", "--name-only", "--diff-filter=ACM", "-z").split("\0") if f]
    bad = []
    for name in names:
        ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name.split("/")[-1] else ""
        if ext not in TEXT_EXT:
            continue
        blob = git("show", ":" + name, binary=True)
        try:
            blob.decode("utf-8")
        except UnicodeDecodeError:
            bad.append((name, len(blob)))
    if bad:
        print("\n[提交被拦下] 下面这些文本文件不是合法 UTF-8（多半被 DLP 加密后落盘了）：")
        for name, size in bad:
            print("   %s  (%d 字节)" % (name, size))
        print("\n处理办法：用 PowerShell / 记事本 / 编辑器重新保存该文件（不要用 Python 写），")
        print("再 git add 一次。参考 README 的「在这台机器上改代码要注意」一节。\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())