# 基础规范
The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED",  "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 注释
* 当用户让你参考某某编写代码的时候，**禁止 MUST NOT**留有“对照XXX”“对齐旧版逻辑”“按照 Python 代码逻辑”等对齐类注释。
* **禁止 MUST NOT**留下“XXX（§3.5）”“参考 plan §2.6”这种引用注释文本。

## 重构
* 当用户提出要重构代码，或要修复的问题涉及到代码架构问题时，**必须 MUST**在制定方案前，向用户提问采用哪个方案：
  1. 快速止血：以最小成本改动
  2. 适当重构（默认）：在一般容许范围内，尽量根本解决问题
  3. 重大重构：不计任何成本，允许彻底性的架构重构，以从根本上长期解决问题

## 流水线
* 如果本项目有配置任何单测或 Lint 或类型检查，在任务完成后，**必须 MUST**保证单测、Lint 与类型检查均无错误。
* 如果某个问题为存量问题，那么**SHALL 应当**忽略这个问题，除非用户要求。
