// Catalog of actions offered by the inline quick-actions menu (shown on hover on
// each file/folder row and on the current-folder name in the toolbar). Each entry
// declares in which contexts it applies: `item` (a row) and/or `folder` (the
// current folder at the top). The actual execution lives in ExplorerContextMenu
// (item context, reuses the right-click machinery incl. share/delete dialogs) and
// in useFolderQuickActions (folder context, a dialog-free safe subset).
import {
  InformationCircleIcon,
  ArrowDownTrayIcon,
  DocumentDuplicateIcon,
  ClipboardDocumentIcon,
  Square2StackIcon,
  ScissorsIcon,
  PencilSquareIcon,
  ShareIcon,
  ArchiveBoxArrowDownIcon,
  StarIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline';

export const QUICK_ACTIONS = [
  { id: 'info', labelKey: 'context.getInfo', icon: InformationCircleIcon, item: true, folder: true },
  { id: 'download', labelKey: 'actions.download', icon: ArrowDownTrayIcon, item: true, folder: false },
  { id: 'copyName', labelKey: 'actions.copyName', icon: DocumentDuplicateIcon, item: true, folder: true },
  { id: 'copyPath', labelKey: 'actions.copyPath', icon: ClipboardDocumentIcon, item: true, folder: true },
  { id: 'copy', labelKey: 'actions.copy', icon: Square2StackIcon, item: true, folder: false },
  { id: 'cut', labelKey: 'actions.cut', icon: ScissorsIcon, item: true, folder: false },
  { id: 'rename', labelKey: 'actions.rename', icon: PencilSquareIcon, item: true, folder: false },
  { id: 'share', labelKey: 'actions.share', icon: ShareIcon, item: true, folder: false },
  { id: 'compress', labelKey: 'actions.compressToZip', icon: ArchiveBoxArrowDownIcon, item: true, folder: false },
  { id: 'favorite', labelKey: 'context.addToFavorites', icon: StarIcon, item: true, folder: true },
  { id: 'delete', labelKey: 'common.delete', icon: TrashIcon, item: true, folder: false, danger: true },
];

export const QUICK_ACTION_IDS = QUICK_ACTIONS.map((action) => action.id);

export const QUICK_ACTIONS_BY_ID = Object.fromEntries(
  QUICK_ACTIONS.map((action) => [action.id, action])
);

export const DEFAULT_QUICK_ACTION_ORDER = QUICK_ACTION_IDS.slice();

// Sensible default selection so the menu is useful out of the box.
export const DEFAULT_QUICK_ACTIONS_ON = [
  'info',
  'download',
  'copyName',
  'copy',
  'cut',
  'rename',
  'share',
  'delete',
];

export const defaultQuickActionConfig = () =>
  DEFAULT_QUICK_ACTION_ORDER.map((id) => ({ id, on: DEFAULT_QUICK_ACTIONS_ON.includes(id) }));
