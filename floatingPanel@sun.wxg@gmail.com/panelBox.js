const { GLib, Clutter, Gio, GObject, Shell, St } = imports.gi;

const Main = imports.ui.main;
const DND = imports.ui.dnd;
const AppFavorites = imports.ui.appFavorites;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const ItemContainer = Me.imports.itemContainer.ItemContainer;
const SwitchWorkspace = Me.imports.switchWorkspace.SwitchWorkspace;
const NUMBER_TO_CHAR_UPPERCASE = Me.imports.util.NUMBER_TO_CHAR_UPPERCASE;
const NUMBER_TO_CHAR = Me.imports.util.NUMBER_TO_CHAR;
const Util = Me.imports.util;

const ICON_FILE = 'floating-panel-icon-file';
const PANEL_POSITION = 'floating-panel-position';

var ITEM_ANIMATION_TIME = 100;

var WINDOW_DND_SIZE = 256;
var DRAGGING_WINDOW_OPACITY = 0;

var DragDropResult = {
    FAILURE:  0,
    SUCCESS:  1,
    CONTINUE: 2,
};

var PanelBox = GObject.registerClass({
    Signals: {
    },
}, class PanelBox extends St.BoxLayout {
    _init(direction, iconSize, settings) {
        super._init({ name: 'floating-panel',
                      can_focus: true,
                      reactive: true,
                      x_align: Clutter.ActorAlign.CENTER });

        this.settings = settings;
        this.iconSize = iconSize;
        this.direction = direction;
        switch (direction) {
        case St.Side.TOP:
        case St.Side.BOTTOM:
            this.set_vertical(true);
            break;
        case St.Side.LEFT:
        case St.Side.RIGHT:
            this.set_vertical(false);
            break;
        default:
            break;
        }

        this._mainButton = this._createMainButton();
        this._mainButton._delegate = this;
        this._draggable = DND.makeDraggable(this._mainButton,
                                            { restoreOnSuccess: false,
                                              manualMode: false,
                                              dragActorMaxSize: WINDOW_DND_SIZE,
                                              dragActorOpacity: DRAGGING_WINDOW_OPACITY });
        this._draggable.connect('drag-begin', this._onDragBegin.bind(this));
        this._draggable.connect('drag-cancelled', this._onDragCancelled.bind(this));
        this._draggable.connect('drag-end', this._onDragEnd.bind(this));

        this._mainButton.connect('clicked', this._mainButtonClicked.bind(this));
        let switchWorkspace = new SwitchWorkspace();
        this._mainButton.connect('scroll-event', switchWorkspace.scrollEvent.bind(switchWorkspace));

        this.iconFileID = this.settings.connect("changed::" + ICON_FILE, () => {
            let icon = new St.Icon({ gicon: this._createButtonIcon(),
                                     icon_size: this.iconSize });
            this._mainButton.set_child(icon);
        });

        this.add_child(this._mainButton)

        this._label = new St.Label({ style_class: 'dash-label',
                                     text: 'Press ESC to cancel' });
        this._label.hide();
        Main.layoutManager.addChrome(this._label);
        this.label_actor = this._label;

        let [x, y] = this.settings.get_value(PANEL_POSITION).deep_unpack();
        //let workspaceManager = global.workspace_manager;
        //let ws = workspaceManager.get_active_workspace();
        //let workArea = ws.get_work_area_all_monitors();
        //if (x < workArea.x || x > workArea.x + workArea.width)
            //x = workArea.x + workArea.width / 2;
        //if (y < workArea.y || y > workArea.y + workArea.height)
            //y = workArea.y + workArea.height / 2;
        this.x = x;
        this.y = y;
        this._x = x;
        this._y = y;
        this._mainButtonX = x;
        this._mainButtonY = y;

        this._showApp = false;
        this._vimMode = false;
        this._inDrag = false;
        this._inPreviewMode = false;
        this._inPreviewButton = null;
        this._timeoutId = 0;

        this._box = new ItemBox(this.direction);
        switch (direction) {
        case St.Side.LEFT:
        case St.Side.TOP:
            this.insert_child_below(this._box, null);
            break;
        case St.Side.BOTTOM:
        case St.Side.RIGHT:
            this.insert_child_above(this._box, null);
            break;
        default:
            break;
        }

        this._workId = Main.initializeDeferredWork(this, this._redisplay.bind(this));

        this._appSystem = Shell.AppSystem.get_default();

        this._appSystem.connect('installed-changed', () => {
            AppFavorites.getAppFavorites().reload();
            this.queueRedisplay();
        });

        AppFavorites.getAppFavorites().connect('changed', this.queueRedisplay.bind(this));
        this._appSystem.connect('app-state-changed', this.queueRedisplay.bind(this));

        this._overViewShownID = Main.overview.connect('showing', () => { this.hide() });
        this._overViewHiddenID = Main.overview.connect('hiding', () => { this.show() });

        this._workspaceChangedID = global.workspace_manager.connect('active-workspace-changed',
                                                                    this.queueRedisplay.bind(this));
        Main.layoutManager.addChrome(this, { trackFullscreen: true });
    }

    _createMainButton() {
        let icon = new St.Icon({ gicon: this._createButtonIcon(),
                                 icon_size: this.iconSize });

        let button= new St.Button({ style_class: 'main-button',
                                    child: icon });

        return button;
    }

    _createButtonIcon() {
        let uri = this.settings.get_string(ICON_FILE)
        if (!GLib.file_test(uri, GLib.FileTest.EXISTS))
            uri = Me.path + '/icons/flag.png';

        return  new Gio.FileIcon({ file: Gio.File.new_for_path(uri) });
    }

    _getDragButton() {
        let icon = new St.Icon({ gicon: this._createButtonIcon(),
                                 icon_size: this.iconSize });

        let button= new St.Button({ style_class: 'item-container',
                                    child: icon });

        return button;
    }

    _updatePositionRedisplay(oldLength, oldWidth, oldHeight){
        let [x, y] = this.get_position();
        let children = this._box.get_children();
        let newWidth = (oldWidth / oldLength) * children.length;
        let newHeight = (oldHeight / oldLength) * children.length;

        switch (this.direction) {
        case St.Side.TOP:
            this._y = y - (newHeight - oldHeight);
            break;
        case St.Side.LEFT:
            this._x = x - (newWidth - oldWidth);
            break;
        case St.Side.BOTTOM:
        case St.Side.RIGHT:
        default:
            break;
        }

        //if (this._showApp)
            //this._sureInWorkArea();
    }

    _redisplay() {
        let oldLength = this._box.get_children().length;
        let box = this._box.get_allocation_box();
        let oldWidth = box.x2 - box.x1;
        let oldHeight = box.y2 - box.y1;

        let children = this._box.get_children();
        children.map(actor => { actor.destroy(); });

        this._itemNumber = 0;
        this._getFavorites();
        this._addApps();

        //if ((oldLength != this._box.get_children().length) &&
            //this._showApp && !this._vimMode)
            //this._updatePositionRedisplay(oldLength, oldWidth, oldHeight);

        this._showPanel(this._x, this._y, false);
    }

    _findInBox(app) {
        let children = this._box.get_children();
        let result = false;
        for (let i = 0; i < children.length; i++) {
            if (children[i].app.id == app.id) {
                result = true;
                break;
            }
        }
        return result;
    }

    _addApps() {
        this._appSystem = Shell.AppSystem.get_default();
        let running = this._appSystem.get_running();

        running = running.filter(function(app) {
            return Util.appInActiveWorkspace(app);
        });

        for (let i = 0; i < running.length; i++) {
            if (this._findInBox(running[i]))
                continue;

            let item = new ItemContainer(running[i], this._vimMode, this._itemNumber++, this.iconSize);
            item.child.connect('activate-window', this._activateWindow.bind(this));
            item.child.connect('in-preview', (button, state) => {
                this._inPreviewMode = state;
                if (state)
                    this._inPreviewButton = button;
            });

            this._box.add_child(item);
        }
    }

    _getFavorites() {
        let favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        for (let i in favorites) {
            let item = new ItemContainer(favorites[i], this._vimMode, this._itemNumber++, this.iconSize);
            item.child.connect('activate-window', this._activateWindow.bind(this));
            item.child.connect('in-preview', (button, state) => {
                this._inPreviewMode = state;
                if (state)
                    this._inPreviewButton = button;
            });

            this._box.add_child(item);
        }
    }

    _activateWindow() {
        if (!this._showApp)
            return;
        this._showApp = false;
        //this._updatePosition('hide');
        this._showPanel(this._x, this._y, true);
    }

    _previewSelected(number) {
        let children = this._box.get_children();
        let window = null;
        children.forEach( (element) => {
            let w = element.child.findPreviewMenu(number);
            if (w != null)
                window = w;
        });

        if (!window)
            return;

        Main.activateWindow(window);
        this._hideAppList();
    }

    _appItemSelected(number, newWindow) {
        let children = this._box.get_children();
        let item = children.find( (element) => {
            return element.number == number;
        });

        if (!item)
            return;

        let  windows = Util.windowsInActiveWorkspace(item.child.app);
        if (newWindow || !Util.appInActiveWorkspace(item.child.app)) {
            item.child.newWindow = newWindow;
            item.child.app.open_new_window(-1);

        } else if ( windows.length == 1) {
            Main.activateWindow(windows[0]);

        }  else if (windows.length > 1) {
            this._inPreviewMode = true;
            item.child._showPreviews();
            return;
        }

        this._hideAppList();
    }

    _updatePosition(action) {
        let box = this._box.get_allocation_box();
        let boxWidth = box.x2 - box.x1;
        let boxHeight = box.y2 - box.y1;
        let [x, y] = this.get_position();
        switch (this.direction) {
        case St.Side.TOP:
            if (action == 'show')
                this._y = y - boxHeight;
            else
                this._y = y + boxHeight;
            break;
        case St.Side.LEFT:
            if (action == 'show')
                this._x = x - boxWidth;
            else
                this._x = x + boxWidth;
            break;
        case St.Side.BOTTOM:
        case St.Side.RIGHT:
        default:
            break;
        }

        //if (action == 'show')
            //this._sureInWorkArea();
    }

    //_sureInWorkArea() {
        //let workspaceManager = global.workspace_manager;
        //let ws = workspaceManager.get_active_workspace();
        //let workArea = ws.get_work_area_all_monitors();

        //let box = this._box.get_allocation_box();
        //let mainButton = this._mainButton.get_allocation_box();
        //let width = box.x2 - box.x1 + mainButton.x2 - mainButton.x1;
        //let height = box.y2 - box.y1 + mainButton.y2 - mainButton.y1;

        //switch (this.direction) {
        //case St.Side.TOP:
            //this._y = this._y < workArea.y ? workArea.y : this._y;
            //if (this._y + height > workArea.y + workArea.height)
                //this._y = workArea.y + workArea.height - height;
            //break;
        //case St.Side.BOTTOM:
            //if (this._y + height > workArea.y + workArea.height)
                //this._y = workArea.y + workArea.height - height;
            //this._y = this._y < workArea.y ? workArea.y : this._y;
            //break;
        //case St.Side.LEFT:
            //this._x = this._x < workArea.x ? workArea.x : this._x;
            //if (this._x + width > workArea.x + workArea.width)
                //this._x = workArea.x + workArea.width - width;
            //break;
        //case St.Side.RIGHT:
            //if (this._x + width > workArea.x + workArea.width)
                //this._x = workArea.x + workArea.width - width;
            //this._x = this._x < workArea.x ? workArea.x : this._x;
            //break;
        //default:
            //break;
        //}
    //}

    _mainButtonClicked() {
        this._showApp = !this._showApp;
        if (this._showApp) {
            this._box.show();
            //this._updatePosition('show');
            //this._sureInWorkArea();
        } else {
            //this._updatePosition('hide');
        }
        this._showPanel(this._x, this._y, true);
    }

    _hideAppList() {
            this._showApp = false;
            this._vimMode = false;
            this._mainButton.reactive = true;
            Main.popModal(this);
            //this._updatePosition('hide');
            this._redisplay();
    }

    _showPanel(x, y, animation) {
        //animation = false;
        this._x = x;
        this._y = y;

        if (this._vimMode)
            this._showLabel();
        else
            this._label.hide();

        if (this._showApp) {
            this.set_position(this._x, this._y);
            this._box.show();

            if (animation)
                this._boxAnimationShow();
        } else {
            if (animation) {
                this._boxAnimationHide();
            } else {
                this.set_position(this._x, this._y);
                this._box.hide();
            }
        }

        this._recordMainButtonPosition();
    }

    _boxAnimationShow() {
        let params = Object.assign({
            duration: ITEM_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });

        switch (this.direction) {
        case St.Side.TOP:
            this._box.scale_y = 0;
            this._box.set_pivot_point(1, 1);
            this._box.ease(Object.assign({ scale_y: 1 }, params));
            break;
        case St.Side.BOTTOM:
            this._box.scale_y = 0;
            this._box.set_pivot_point(0, 0);
            this._box.ease(Object.assign({ scale_y: 1 }, params));
            break;
        case St.Side.RIGHT:
            this._box.scale_x = 0;
            this._box.set_pivot_point(0, 0);
            this._box.ease(Object.assign({ scale_x: 1 }, params));
            break;
        case St.Side.LEFT:
            this._box.scale_x = 0;
            this._box.set_pivot_point(1, 1);
            this._box.ease(Object.assign({ scale_x: 1 }, params));
            break;
        default:
            break;
        }
    }

    _boxAnimationHide() {
        let params = Object.assign({
            duration: ITEM_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        switch (this.direction) {
        case St.Side.TOP:
            this._box.set_pivot_point(1, 1);
            this._box.ease(Object.assign(params, {
                scale_y: 0,
                onComplete: () => {
                    this._box.scale_y = 1;
                    this._box.hide();
                    this.set_position(this._x, this._y);
                },
            }));
            break;
        case St.Side.BOTTOM:
            this._box.set_pivot_point(0, 0);
            this._box.ease(Object.assign(params, {
                scale_y: 0,
                onComplete: () => {
                    this._box.scale_y = 1;
                    this._box.hide();
                    this.set_position(this._x, this._y);
                },
            }));
            break;
        case St.Side.RIGHT:
            this._box.set_pivot_point(0, 0);
            this._box.ease(Object.assign(params, {
                scale_x: 0,
                onComplete: () => {
                    this._box.scale_x = 1;
                    this._box.hide();
                    this.set_position(this._x, this._y);
                },
            }));
            break;
        case St.Side.LEFT:
            this._box.set_pivot_point(1, 1);
            this._box.ease(Object.assign(params, {
                scale_x: 0,
                onComplete: () => {
                    this._box.scale_x = 1;
                    this._box.hide();
                    this.set_position(this._x, this._y);
                },
            }));
            break;
        default:
            break;
        }
    }

    _recordMainButtonPosition() {
        if (this._timeoutId != 0)
            return;

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;

            let mainButton = Shell.util_get_transformed_allocation(this._mainButton);
            this.settings.set_value(PANEL_POSITION,
                                new GLib.Variant('ai', [mainButton.x1 ,mainButton.y1]));
            print("wxg: set_value x y=", mainButton.x1, mainButton.y1);

            return GLib.SOURCE_REMOVE;
        });
    }

    _showLabel() {
        this._label.show();
        let labelHeight = this._label.get_height();
        let labelWidth = this._label.get_width();
        let boxWidth = this.get_width();
        let boxHeight = this.get_height();

        let x, y;
        switch (this.direction) {
        case St.Side.TOP:
        case St.Side.BOTTOM:
            x = this._x - labelWidth;
            if (x < 0)
                x = this._x + boxWidth;
            y = this._y;
            break;
        case St.Side.RIGHT:
        case St.Side.LEFT:
            x = this._x;
            y = this._y - labelHeight;
            if (y < 0)
                y = this._y + boxHeight;
            break;
        default:
            break;
        }
        this._label.set_position(x, y);
    }

    showItem() {
        this._vimMode = true;
        this._mainButton.reactive = false;
        if (!this._showApp) {
            this._showApp = true;
            this._box.show();
            //this._updatePosition('show');
        }
        Main.queueDeferredWork(this._workId);

        Main.pushModal(this);
    }

    _sureInWorkArea(box) {
        let workspaceManager = global.workspace_manager;
        let ws = workspaceManager.get_active_workspace();
        let workArea = ws.get_work_area_all_monitors();

        let boxWidth = box.x2 - box.x1;
        let boxHeight = box.y2 - box.y1;

        let x = box.x1;
        let y = box.y1;

        if (box.x1 < workArea.x) {
            x = workArea.x;
        } else if (box.x2 > (workArea.x + workArea.width)) {
            x = workArea.x + workArea.width - boxWidth;
        }

        if (box.y1 < workArea.y) {
            y = workArea.y;
        } else if (box.y2 > (workArea.y + workArea.height)) {
            y = workArea.y + workArea.height - boxHeight;
        }

        switch (this.direction) {
            case St.Side.TOP:
                if (boxHeight > workArea.height)
                    y = workArea.y + workArea.height - boxHeight;
                break;
            case St.Side.BOTTOM:
                if (boxHeight > workArea.height)
                    y = workArea.y;
                break;
            case St.Side.LEFT:
                if (boxWidth > workArea.width)
                    x = workArea.x + workArea.width - boxWidth;
                break;
            case St.Side.RIGHT:
                if (boxWidth > workArea.width)
                    x = workArea.x;
            default:
                break;
        }
        box.set_origin(x, y);
    }

    vfunc_allocate(box, flags) {
        super.vfunc_allocate(box,flags);
        if (this._mainButton == null)
            return;

        let boxWidth = box.x2 - box.x1;
        let boxHeight = box.y2 - box.y1;

        let mainButtonBox = this._mainButton.get_allocation_box();
        let mainButtonWidth = mainButtonBox.x2 - mainButtonBox.x1;
        let mainButtonHeight = mainButtonBox.y2 - mainButtonBox.y1;

        let x = box.x1;
        let y = box.y1;

        //print("wxg: y1=", y);
        if (!this._inDrag) {
            switch (this.direction) {
            case St.Side.TOP:
                y = this._mainButtonY - (boxHeight - mainButtonHeight);
                break;
            case St.Side.LEFT:
                x = this._mainButtonX - (boxWidth - mainButtonWidth);
                break;
            case St.Side.BOTTOM:
            case St.Side.RIGHT:
            default:
                break;
            }

            box.set_origin(x, y);
            this._sureInWorkArea(box);
            this.set_allocation(box, flags);
        }

        //print("wxg: y3=", y);
        this._x = box.x1;
        this._y = box.y1;

        //box.set_origin(x, y);
        //this.set_allocation(box, flags);

        let mainButton = Shell.util_get_transformed_allocation(this._mainButton);
        this._mainButtonX = mainButton.x1;
        this._mainButtonY = mainButton.y1;
    }

    vfunc_key_press_event(keyEvent) {
        let symbol = keyEvent.keyval;
        print("wxg: key_press_event=", symbol, this._inPreviewMode);
        if (symbol == Clutter.KEY_Escape && this._inPreviewMode) {
            this._inPreviewButton._previewMenu.close();
            return Clutter.EVENT_STOP;
        }

        if (symbol == Clutter.KEY_Escape) {
            this._inPreviewMode = false;
            this._hideAppList();
            return Clutter.EVENT_STOP;
        }

        let number = NUMBER_TO_CHAR.findIndex( (element) => {
                                                return element == symbol; });
        if (number >= 0) {
            if (this._inPreviewMode)
                this._previewSelected(number);
            else
                this._appItemSelected(number, false);

            return Clutter.EVENT_STOP;
        }

        number = NUMBER_TO_CHAR_UPPERCASE.findIndex( (element) => {
                                                return element == symbol; });
        if (number >= 0 && !this._inPreviewMode) {
            this._appItemSelected(number, true);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_STOP;
    }

    queueRedisplay() {
        this._vimMode = false;
        this._mainButton.reactive = true;
        Main.queueDeferredWork(this._workId);
    }

    _onDragMotion(dropEvent) {
        let lastX, lastY;
        switch (this.direction) {
        case St.Side.TOP:
            [lastX, lastY] = this._mainButton.get_position();
            this._x = dropEvent.dragActor.x;
            this._y = dropEvent.dragActor.y - lastY;
            break;
        case St.Side.LEFT:
            [lastX, lastY] = this._mainButton.get_position();
            this._x = dropEvent.dragActor.x - lastX;
            this._y = dropEvent.dragActor.y;
            break;
        case St.Side.BOTTOM:
        case St.Side.RIGHT:
            this._x = dropEvent.dragActor.x;
            this._y = dropEvent.dragActor.y;
        default:
            break;
        }

        //print("wxg: _x _y", this._x, this._y);
        this._showPanel(this._x, this._y, false);
        return DND.DragMotionResult.CONTINUE;
    }

    _onDragBegin(_draggable, _time) {
        this._inDrag = true;
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _onDragCancelled(_draggable, _time) {
        this._inDrag = false;
    }

    _onDragEnd(_draggable, _time, _snapback) {
        this._inDrag = false;
        DND.removeDragMonitor(this._dragMonitor);

        //if (this._showApp)
            //this._sureInWorkArea();
        //this._showPanel(this._x, this._y, false);
        this._showPanel(this._x - 1, this._y);
        //this.set_position(0, 0);
        this._updateMenuStyle();
    }

    getDragActor() {
        return this._getDragButton();
    }

    getDragActorSource() {
        return this._mainButton;
    }

    acceptDrop() {
        return true;
    }

    _updateMenuStyle() {
        let children = this._box.get_children();
        children.forEach( (item) => {
            let button = item.child;
            if (button._previewMenu != null) {
                button._previewMenu.destroy();
                button._previewMenu = null;
            }
        });
    }

    destroy() {
        if (this._overViewShownID)
            Main.overview.disconnect(this._overViewShownID);
        if (this._overViewHiddenID)
            Main.overview.disconnect(this._overViewHiddenID);
        if (this._workspaceChangedID)
            global.workspace_manager.disconnect(this._workspaceChangedID);

        if (this.iconFileID)
            this.settings.disconnect(this.iconFileID);

        Main.layoutManager.removeChrome(this._label);
        Main.layoutManager.removeChrome(this);
    }
});

var ItemBox = GObject.registerClass(
class ItemBox extends St.BoxLayout {
    _init(direction) {
        super._init({ style_class: 'item-box' });

        switch (direction) {
        case St.Side.TOP:
        case St.Side.BOTTOM:
            this.set_vertical(true);
            break;
        case St.Side.LEFT:
        case St.Side.RIGHT:
            this.set_vertical(false);
            break;
        default:
            break;
        }
    }
});
