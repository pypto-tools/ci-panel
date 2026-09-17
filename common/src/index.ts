import GlobalVariable from "./global_variable";
import InstanceStreamListener from "./instance_stream";
import StorageSubsystem from "./system_storage";

export { ProcessWrapper, killProcess } from "./process_tools";
export {
  IDataSource,
  LocalFileSource,
  MySqlSource,
  QueryMapWrapper,
  QueryWrapper
} from "./query_wrapper";
export { systemInfo } from "./system_info";

export {
  configureEntityParams,
  isEmpty,
  supposeValue,
  toBoolean,
  toNumber,
  toText
} from "./typecheck";

export { arrayUnique } from "./array";

// runner 纳管协议（纯类型，前端用 import type 引，不会带进浏览器 bundle）
export type {
  ControlOutcome,
  EnvTarget,
  RegisterRunnerItem,
  RegisterRunnerResult,
  RegisterRunnersResponse,
  RepoRunnerRef,
  RunnerEnvResult,
  RunnerEnvSection,
  RunnerEnvVar,
  RunnerOwnership,
  RunnerRunState,
  RunnerRuntimeState,
  RunnerSource,
  ScannedRunner,
  ServiceControlResult,
  SupervisorAction,
  SupervisorKind,
  SystemdAction,
  SystemdStateCompat
} from "./runner_protocol";

// 同一份协议里唯一的运行时导出，供 panel 转发 daemon 回复时用。前端不引它（只 import type），
// 所以浏览器 bundle 不受影响。
export { collectRegisteredRepoSlugs } from "./runner_protocol";

// 插件契约（三方共用 + 仓库外的插件作者按同一份实现）。类型给前端 import type 用；
// 下面那组运行时导出只有 panel 与 daemon 会引，前端不引，浏览器 bundle 不受影响。
export type {
  ContractVerdict,
  PluginBadgeTone,
  PluginCardSpec,
  PluginCell,
  PluginDataPayload,
  PluginDataSourceSpec,
  PluginErrorCode,
  PluginErrorReply,
  PluginHealthPayload,
  PluginHealthStatus,
  PluginI18nCatalogues,
  PluginManifest,
  PluginManifestValidation,
  PluginOkReply,
  PluginPageSpec,
  PluginRenderKind,
  PluginReply,
  PluginResourceLimits,
  PluginRow,
  PluginRuntimeKind,
  PluginRuntimeSpec,
  PluginViewSpec
} from "./plugin_protocol";

export {
  PLUGIN_BADGE_TONES,
  PLUGIN_CONTRACT_CURRENT,
  PLUGIN_CONTRACT_MIN_SUPPORTED,
  PLUGIN_ERROR_CODES,
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_PATTERN,
  PLUGIN_I18N_KEY_PATTERN,
  PLUGIN_I18N_PREFIX,
  PLUGIN_RENDER_KINDS,
  PLUGIN_TEXT_MAX_LENGTH,
  checkContract,
  isSafeI18nValue,
  isValidPluginId,
  pluginI18nKey,
  validatePluginManifest
} from "./plugin_protocol";

export { removeTrail } from "./string_utils";

export {
  normalizeDockerArchitecture,
  normalizeDockerOS,
  normalizeDockerPlatform
} from "./docker_utils";

export { GlobalVariable, InstanceStreamListener, StorageSubsystem };
