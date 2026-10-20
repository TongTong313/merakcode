// 运行时与打包提供、TypeScript 本身不认识的东西

/** 提示词等文本文件按字符串导入（打包时内联） */
declare module "*.txt" {
  const content: string
  export default content
}

interface ImportMeta {
  /** 当前模块是否是进程入口（Node ≥ 24.2） */
  readonly main: boolean
}
