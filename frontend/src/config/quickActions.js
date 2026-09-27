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

const QUICK_ACTIONS = [
  {
    id: 'info',
    labelKey: 'context.getInfo',
    icon: InformationCircleIcon,
    item: true,
    folder: true,
  },
  {
    id: 'download',
    labelKey: 'actions.download',
    icon: ArrowDownTrayIcon,
    item: true,
    folder: false,
  },
  {
    id: 'copyName',
    labelKey: 'actions.copyName',
    icon: DocumentDuplicateIcon,
    item: true,
    folder: true,
  },
  {
    id: 'copyPath',
    labelKey: 'actions.copyPath',
    icon: ClipboardDocumentIcon,
    item: true,
    folder: true,
  },
  { id: 'copy', labelKey: 'actions.copy', icon: Square2StackIcon, item: true, folder: false },
  { id: 'cut', labelKey: 'actions.cut', icon: ScissorsIcon, item: true, folder: false },
  { id: 'rename', labelKey: 'actions.rename', icon: PencilSquareIcon, item: true, folder: false },
  { id: 'share', labelKey: 'actions.share', icon: ShareIcon, item: true, folder: false },
  {
    id: 'compress',
    labelKey: 'actions.compressToZip',
    icon: ArchiveBoxArrowDownIcon,
    item: true,
    folder: false,
  },
  { id: 'favorite', labelKey: 'context.addToFavorites', icon: StarIcon, item: true, folder: true },
  {
    id: 'delete',
    labelKey: 'common.delete',
    icon: TrashIcon,
    item: true,
    folder: false,
    danger: true,
  },
];

export const QUICK_ACTION_IDS = QUICK_ACTIONS.map((action) => action.id);

export const QUICK_ACTIONS_BY_ID = Object.fromEntries(
  QUICK_ACTIONS.map((action) => [action.id, action])
);

const DEFAULT_QUICK_ACTION_ORDER = QUICK_ACTION_IDS.slice();

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

/**
 * Where the icons sit inside the name column.
 *
 * `after` is where they have always been: immediately right of the name, so
 * their place on screen follows the length of the name and no two rows agree.
 * The other two put them at an edge of the column, which is the only way they
 * line up down the list — `start` before the name, `end` after everything.
 */
export const QUICK_ACTION_POSITIONS = ['after', 'start', 'end'];

/**
 * How much room to keep at that edge, in pixels, for `count` icons.
 *
 * Reserved from the count the reader configured rather than from what a given
 * row offers: a row where half the actions do not apply would otherwise reserve
 * less and put its name — and its icons — somewhere no other row has them.
 *
 * Reserved whether or not the row is hovered, and in compact mode reserved as
 * though the "…" had already expanded. Both for the same reason: the name must
 * not move when the pointer arrives, and the icons must not open over it.
 *
 * The numbers are the buttons' own: `h-6 w-6` is 24 and the `gap-0.5` between
 * them is 2. The space between the icons and the name is not in here — that one
 * is the row's own `gap-x-1.5`, and counting it twice would be a gap of twelve.
 */
export const quickActionsReservedWidth = (count) => (count > 0 ? count * 24 + (count - 1) * 2 : 0);
