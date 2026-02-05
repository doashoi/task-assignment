document.addEventListener('DOMContentLoaded', () => {
    // 初始化腾讯云开发（必须放在代码最顶部，环境ID复制腾讯云的，一字不差）
    const app = cloudbase.init({ env: "share-task-01-3gx43chof7e199ad" }); // TODO: 请替换为您真实的环境ID
    const db = app.database().collection("task_data"); // 关联你的集合
    const auth = app.auth();

    // 改用新的 Storage Key
    const STORAGE_KEY = 'taskPlanData';
    const DEFAULT_PERSONNEL = ['畅为', '尚哥', '白云', '喆杰', '可欣', '嘉豪', '孜尊', '晟杰', '星宇', '俊鹏', '英祺', '璐燚', '俊杰', '依婷'];
    
    const listContainer = document.querySelector('.personnel-list');
    const assignedAreas = document.querySelectorAll('.assigned-area');
    const leftDatePlaceholders = document.querySelectorAll('.date-placeholder-left');
    const rightDatePlaceholders = document.querySelectorAll('.date-placeholder');

    const PERSONNEL_COLORS = [
        '#E0E7FF', '#DBEAFE', '#FCE7F3', '#D1FAE5', '#EDE9FE', 
        '#FEF3C7', '#CFFAFE', '#ECFCCB', '#FCE7F3', '#E0F2FE', 
        '#F1F5F9', '#FFEDD5', '#FAE8FF', '#CCFBF1', '#FEE2E2', 
        '#E0E7FF', '#DCFCE7', '#DBEAFE', '#FEF9C3', '#FFE4E6'
    ];

    let taskData = {
        leftPersonList: [],
        rightPersonMap: {},  // {'0': {'sectionId': [{name: 'xxx', todos: [], isExpanded: false}]}}
        taskSections: {}, // {'0': [{id: 'guid', title: '板块名称', todos: []}]}
        taskPresets: ['早班巡检', '午间清理', '晚班移交', '周报整理'],
        todoPresets: ['日常巡检', '环境清洁', '设备维护', '文档整理', '客户接待'],
        sectionPresets: ['日常任务', '专项任务', '临时增援', '值班工作'],
        dayStates: {}
    };

    let todayIndex = -1;
    let sidebarCurrentDateIndex = 0;
    let currentViewMonday = null; // 当前视图显示的周一日期
    
    // 用于防抖保存和避免冲突
    let saveTimeout = null;
    let isLocalWriting = false;
    let lastLocalWriteTime = 0;

    const sidebar = document.getElementById('sidebar');
    const sidebarDateVal = document.querySelector('.sidebar-date-val');
    const sidebarWeekdayVal = document.querySelector('.sidebar-weekday-val');
    const sidebarDayCols = document.querySelectorAll('.sidebar-day-col');

    async function init() {
        console.log('🚀 [TCB] 初始化开始...');
        // const storedData = localStorage.getItem(STORAGE_KEY);
        let shouldReset = false;
        
        // 尝试匿名登录腾讯云
        try {
            console.log('🔑 [TCB] 正在尝试匿名登录...');
            const loginState = await auth.getLoginState();
            if (!loginState) {
                const res = await auth.anonymousAuthProvider().signIn();
                console.log('✅ [TCB] 匿名登录成功:', res);
            } else {
                console.log('ℹ️ [TCB] 已处于登录状态');
            }
        } catch (e) {
            console.error('❌ [TCB] 匿名登录失败:', e);
        }

        // 初始化当前视图的周一
        const today = new Date();
        const currentDay = today.getDay();
        const distanceToMonday = (currentDay === 0 ? 7 : currentDay) - 1;
        currentViewMonday = new Date(today);
        currentViewMonday.setHours(0, 0, 0, 0);
        currentViewMonday.setDate(today.getDate() - distanceToMonday);

        try {
            // 改造 1：「读取数据」—— 从腾讯云数据库读
            console.log('📥 [TCB] 正在从云端读取最新数据...');
            const res = await db.orderBy("time", "desc").limit(1).get();
            console.log('📦 [TCB] 云端读取原始响应:', res);

            if (res.data && res.data.length > 0) {
                // 获取最新的一条数据作为当前状态
                taskData = res.data[0].payload;
                console.log('✅ [TCB] 成功获取最新 Payload');
                
                // 数据迁移逻辑：从 0-4 索引迁移到日期 Key
                migrateDataToDateKeys();
                
                if (!taskData.taskPresets) taskData.taskPresets = ['早班巡检', '午间清理', '晚班移交', '周报整理'];
                if (!taskData.todoPresets) taskData.todoPresets = ['日常巡检', '环境清洁', '设备维护', '文档整理', '客户接待'];
                if (!taskData.sectionPresets) taskData.sectionPresets = ['日常任务', '专项任务', '临时增援', '值班工作'];
                if (!taskData.dayStates) taskData.dayStates = {};
                
                // 确保数据结构完整（针对当前周）
                for (let i = 0; i < 5; i++) {
                    const dateKey = getDateKey(i);
                    if (!taskData.dayStates[dateKey]) {
                        taskData.dayStates[dateKey] = { isTodoExpanded: false, isTaskExpanded: false };
                    }
                    if (!taskData.taskSections[dateKey]) {
                        const defaultSectionId = 'default-' + dateKey;
                        taskData.taskSections[dateKey] = [{ id: defaultSectionId, title: '默认任务', todos: [], isExpanded: false }];
                    }
                    if (!taskData.rightPersonMap[dateKey]) {
                        taskData.rightPersonMap[dateKey] = {};
                    }
                }

                if (!taskData.leftPersonList || taskData.leftPersonList.length === 0) {
                    shouldReset = true;
                }
            } else {
                // 云端无数据，初始化默认值
                shouldReset = true;
            }
        } catch (e) {
            console.error('云数据库读取失败:', e);
            shouldReset = true;
        }

        if (shouldReset) {
            resetData(); 
        }

        updateDates(); 
        sidebarCurrentDateIndex = todayIndex !== -1 ? todayIndex : 0;
        updateSidebarDateDisplay();
        renderLeft();
        renderRight();
        initDragDrop();
        
        // 开启实时监听
        watchData();
    }

    function migrateDataToDateKeys() {
        // 如果发现 taskSections 中存在 0-4 的数字键，说明是旧数据，需要迁移到本周的日期键
        const numericKeys = ['0', '1', '2', '3', '4'];
        let hasOldData = false;
        
        numericKeys.forEach(key => {
            if (taskData.taskSections && taskData.taskSections[key]) {
                hasOldData = true;
                const dateKey = getDateKey(parseInt(key));
                
                // 迁移任务板块
                if (!taskData.taskSections[dateKey]) {
                    taskData.taskSections[dateKey] = taskData.taskSections[key];
                }
                delete taskData.taskSections[key];
                
                // 迁移人员映射
                if (taskData.rightPersonMap && taskData.rightPersonMap[key]) {
                    if (!taskData.rightPersonMap[dateKey]) {
                        taskData.rightPersonMap[dateKey] = taskData.rightPersonMap[key];
                    }
                    delete taskData.rightPersonMap[key];
                }
                
                // 迁移展开状态
                if (taskData.dayStates && taskData.dayStates[key]) {
                    if (!taskData.dayStates[dateKey]) {
                        taskData.dayStates[dateKey] = taskData.dayStates[key];
                    }
                    delete taskData.dayStates[key];
                }
            }
        });
        
        if (hasOldData) {
            saveToStorage();
        }
    }

    function getDateKey(index, baseMonday = currentViewMonday) {
        const date = new Date(baseMonday);
        date.setDate(baseMonday.getDate() + index);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function resetData() {
        taskData = {
            leftPersonList: [...DEFAULT_PERSONNEL],
            rightPersonMap: {},
            taskSections: {},
            taskPresets: ['早班巡检', '午间清理', '晚班移交', '周报整理'],
            todoPresets: ['日常巡检', '环境清洁', '设备维护', '文档整理', '客户接待'],
            sectionPresets: ['日常任务', '专项任务', '临时增援', '值班工作'],
            dayStates: {}
        };
        
        // 为本周初始化默认数据
        for (let i = 0; i < 5; i++) {
            const dateKey = getDateKey(i);
            const defaultSectionId = 'default-' + dateKey;
            taskData.taskSections[dateKey] = [{ id: defaultSectionId, title: '默认任务', todos: [], isExpanded: false }];
            taskData.rightPersonMap[dateKey] = { [defaultSectionId]: [] };
            taskData.dayStates[dateKey] = { isTodoExpanded: false, isTaskExpanded: false };
        }
        saveToStorage();
    }

    function updateDates() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = `${today.getMonth() + 1}月${today.getDate()}日`;
        todayIndex = -1;

        for (let i = 0; i < 5; i++) {
            const date = new Date(currentViewMonday);
            date.setDate(currentViewMonday.getDate() + i);
            const dateStr = `${date.getMonth() + 1}月${date.getDate()}日`;
            
            // 只有当日期与今天完全一致（包括年份）时，才设置 todayIndex
            if (date.getTime() === today.getTime()) {
                todayIndex = i;
            }
            
            if (leftDatePlaceholders[i]) leftDatePlaceholders[i].textContent = dateStr;
            if (rightDatePlaceholders[i]) rightDatePlaceholders[i].textContent = dateStr;
        }
    }

    // 周切换逻辑
    window.changeWeek = function(offset) {
        currentViewMonday.setDate(currentViewMonday.getDate() + (offset * 7));
        
        // 确保新周的数据结构完整
        for (let i = 0; i < 5; i++) {
            const dateKey = getDateKey(i);
            if (!taskData.taskSections[dateKey]) {
                const defaultSectionId = 'default-' + dateKey;
                taskData.taskSections[dateKey] = [{ id: defaultSectionId, title: '默认任务', todos: [], isExpanded: false }];
            }
            if (!taskData.rightPersonMap[dateKey]) {
                taskData.rightPersonMap[dateKey] = {};
            }
            if (!taskData.dayStates[dateKey]) {
                taskData.dayStates[dateKey] = { isTodoExpanded: false, isTaskExpanded: false };
            }
        }
        
        updateDates();
        updateSidebarDateDisplay();
        renderLeft();
        renderRight();
        saveToStorage();
    };

    function updateSidebarDateDisplay() {
        const weekdays = ['周一', '周二', '周三', '周四', '周五'];
        let dateStr = leftDatePlaceholders[sidebarCurrentDateIndex] ? leftDatePlaceholders[sidebarCurrentDateIndex].textContent : '--月--日';
        
        const isCollapsed = sidebar.classList.contains('collapsed');
        if (isCollapsed && dateStr.includes('月')) {
            // 在折叠状态下，将 "X月X日" 替换为 "X月\nX日" 实现换行
            dateStr = dateStr.replace('月', '月\n');
        }

        if (sidebarDateVal) sidebarDateVal.textContent = dateStr;
        if (sidebarWeekdayVal) sidebarWeekdayVal.textContent = weekdays[sidebarCurrentDateIndex];
        
        // 侧边栏折叠时的日期显示盒高亮逻辑
        const dateDisplayBox = document.querySelector('.date-display-box');
        if (dateDisplayBox) {
            if (sidebarCurrentDateIndex === todayIndex) {
                dateDisplayBox.classList.add('is-today');
            } else {
                dateDisplayBox.classList.remove('is-today');
            }
        }

        sidebarDayCols.forEach((col, idx) => {
            col.classList.remove('active', 'current-day');
            // 展开模式下不显示 active 状态，只显示今天
            // if (idx === sidebarCurrentDateIndex) col.classList.add('active');
            if (idx === todayIndex) col.classList.add('current-day');
        });
    }

    async function saveToStorage() {
        console.log('⏳ [TCB] 准备写入数据 (等待防抖)...');
        // 使用防抖，避免频繁写入云端
        if (saveTimeout) clearTimeout(saveTimeout);
        
        saveTimeout = setTimeout(async () => {
            console.log('📤 [TCB] 防抖结束，开始执行写入流程...');
            isLocalWriting = true;
            lastLocalWriteTime = Date.now();
            
            try {
                // 确保已经登录
                const loginState = await auth.getLoginState();
                if (!loginState) {
                    console.log('🔑 [TCB] 写入前检测到未登录，尝试重新登录...');
                    await auth.anonymousAuthProvider().signIn();
                }

                console.log('📝 [TCB] 正在向集合 task_data 添加文档...', taskData);
                const res = await db.add({
                    payload: taskData,
                    time: new Date().getTime() // 用于排序
                });
                console.log('✅ [TCB] 写入成功，响应结果:', res);
                // console.log("数据同步成功");
            } catch (err) {
                console.error("❌ [TCB] 云数据库写入失败!", err);
                console.error("❌ [TCB] 错误详情:", JSON.stringify(err));
                // 可以在这里添加一个提示，但不建议用 alert 干扰用户
            } finally {
                // 延迟一小会儿重置标志位，确保 watchData 的 onChange 不会立即覆盖
                setTimeout(() => {
                    isLocalWriting = false;
                    console.log('🔓 [TCB] 写入锁已释放');
                }, 1000);
            }
        }, 800); // 800ms 防抖
    }

    // 数据库变化自动刷新
    function watchData() {
        console.log('📡 [TCB] 开启实时监听...');
        db.orderBy("time", "desc").limit(1).watch({
            onChange: (snapshot) => {
                console.log('👀 [TCB] 收到云端变化推送:', snapshot);
                // 如果本地正在写入，或者距离上次写入时间太短（防止回环覆盖），则跳过云端同步
                if (isLocalWriting || (Date.now() - lastLocalWriteTime < 2000)) {
                    console.log('⚠️ [TCB] 检测到本地正在写入，跳过本次云端推送以防覆盖');
                    return;
                }

                if (snapshot.docs && snapshot.docs.length > 0) {
                    const remoteData = snapshot.docs[0].payload;
                    console.log('🔄 [TCB] 正在应用云端数据更新...');
                    
                    // 深度对比或简单校验，这里为了性能简单覆盖
                    taskData = remoteData;
                    
                    updateDates();
                    updateSidebarDateDisplay();
                    renderLeft();
                    renderRight();
                } else {
                    console.log('ℹ️ [TCB] 推送快照为空（可能是初次建立监听或无数据）');
                }
            },
            onError: (err) => {
                console.error("❌ [TCB] 监听实时数据变化失败!", err);
            }
        });
    }

    function getColorForName(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return PERSONNEL_COLORS[Math.abs(hash) % PERSONNEL_COLORS.length];
    }

    function renderLeft() {
        if (!listContainer) return;
        listContainer.innerHTML = '';
        const isCollapsed = sidebar.classList.contains('collapsed');
        
        taskData.leftPersonList.forEach((name, index) => {
            const row = document.createElement('div');
            row.className = 'personnel-row';
            const blocksContainer = document.createElement('div');
            blocksContainer.className = 'name-blocks-container';

            if (isCollapsed) {
                blocksContainer.appendChild(createNameBlock(name, sidebarCurrentDateIndex, index));
            } else {
                for (let i = 0; i < 5; i++) blocksContainer.appendChild(createNameBlock(name, i, index));
            }
            row.appendChild(blocksContainer);
            listContainer.appendChild(row);
        });
        updateSidebarDateDisplay();
    }

    function createNameBlock(name, dateIndex, sourceIndex) {
        const block = document.createElement('div');
        block.className = 'name-block';
        block.textContent = name;
        block.dataset.name = name;
        block.dataset.dateIndex = dateIndex;
        block.dataset.sourceIndex = sourceIndex;
        block.dataset.source = 'left';
        block.style.background = getColorForName(name);

        if (isDisabled(name, dateIndex)) {
            block.classList.add('disabled');
            block.draggable = false;
        } else {
            block.draggable = true;
            block.addEventListener('dragstart', handleDragStart);
            block.addEventListener('dragend', handleDragEnd);
        }
        return block;
    }

    function renderRight() {
        const dayHeaders = document.querySelectorAll('.day-header');

        assignedAreas.forEach((area, index) => {
            area.innerHTML = '';
            area.dataset.dateIndex = index;
            const dateKey = getDateKey(index);
            
            // 为主视图日期表头添加/移除 current-day 类
            if (dayHeaders[index]) {
                if (index === todayIndex) {
                    dayHeaders[index].classList.add('current-day');
                } else {
                    dayHeaders[index].classList.remove('current-day');
                }
            }

            const sections = taskData.taskSections[dateKey] || [];
            sections.forEach((section, sectionIdx) => {
                const sectionEl = document.createElement('div');
                const isExpanded = section.isExpanded || false;
                sectionEl.className = `task-section ${isExpanded ? 'expanded' : ''}`;
                sectionEl.dataset.sectionId = section.id;
                
                // 设置颜色索引，实现不同板块颜色区分
                sectionEl.dataset.colorIndex = sectionIdx % 6;

                const header = document.createElement('div');
                header.className = 'task-section-header';
                
                const headerLeft = document.createElement('div');
                headerLeft.className = 'task-section-header-left';

                const title = document.createElement('div');
                title.className = 'task-section-title';
                title.textContent = section.title;
                title.title = '点击修改名称';
                title.onclick = (e) => {
                    e.stopPropagation();
                    const newTitle = prompt('请输入新的任务板块名称:', section.title);
                    if (newTitle && newTitle.trim() !== '') {
                        section.title = newTitle.trim();
                        saveToStorage();
                        renderRight();
                    }
                };
                
                const expandBtn = document.createElement('button');
                expandBtn.className = 'btn-toggle-section';
                expandBtn.innerHTML = isExpanded ? '收起' : '展开';
                expandBtn.title = isExpanded ? '收起详细信息' : '展开详细信息';
                expandBtn.onclick = (e) => {
                    e.stopPropagation();
                    section.isExpanded = !isExpanded;
                    saveToStorage();
                    renderRight();
                };

                headerLeft.appendChild(title);
                headerLeft.appendChild(expandBtn);
                header.appendChild(headerLeft);
                
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'btn-remove-card';
                deleteBtn.innerHTML = '×';
                deleteBtn.title = '删除任务板块';
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteSection(index, section.id);
                };
                header.appendChild(deleteBtn);
                
                sectionEl.appendChild(header);

                const content = document.createElement('div');
                content.className = 'task-section-content';

                // 任务说明列表
                section.todos.forEach((todo, todoIdx) => {
                    const item = document.createElement('div');
                    item.className = 'todo-item global-todo-item';
                    
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = todo.done;
                    checkbox.onchange = () => {
                        todo.done = checkbox.checked;
                        saveToStorage();
                        renderRight();
                    };
                    
                    const text = document.createElement('span');
                    text.className = `todo-text ${todo.done ? 'done' : ''}`;
                    text.textContent = todo.text;
                    
                    const delBtn = document.createElement('button');
                    delBtn.className = 'btn-remove-todo';
                    delBtn.textContent = '×';
                    delBtn.onclick = () => {
                        section.todos.splice(todoIdx, 1);
                        saveToStorage();
                        renderRight();
                    };

                    item.appendChild(checkbox);
                    item.appendChild(text);
                    item.appendChild(delBtn);
                    content.appendChild(item);
                });

                const addBtn = document.createElement('button');
                addBtn.className = 'btn-add-global-todo';
                addBtn.textContent = '+ 任务说明';
                addBtn.onclick = () => addGlobalTodo(index, section.id);
                content.appendChild(addBtn);

                // 已分配人员
                const assignedContainer = document.createElement('div');
                assignedContainer.className = 'task-section-assigned';
                assignedContainer.dataset.sectionId = section.id;
                
                const persons = (taskData.rightPersonMap[dateKey] && taskData.rightPersonMap[dateKey][section.id]) || [];
                persons.forEach((personObj, personIndex) => {
                    const card = createPersonCard(personObj, index, section.id, personIndex);
                    assignedContainer.appendChild(card);
                });

                content.appendChild(assignedContainer);
                sectionEl.appendChild(content);
                area.appendChild(sectionEl);
            });

            const addSectionBtn = document.createElement('button');
            addSectionBtn.className = 'btn-add-section';
            addSectionBtn.textContent = '+ 添加任务板块';
            addSectionBtn.onclick = () => addSection(index);
            
            // 添加拖拽支持
            addSectionBtn.addEventListener('dragover', (e) => {
                e.preventDefault();
                addSectionBtn.classList.add('drag-over');
            });
            addSectionBtn.addEventListener('dragleave', () => {
                addSectionBtn.classList.remove('drag-over');
            });
            addSectionBtn.addEventListener('drop', (e) => {
                e.preventDefault();
                addSectionBtn.classList.remove('drag-over');
                const rawData = e.dataTransfer.getData('text/plain');
                if (!rawData) return;
                
                const dragData = JSON.parse(rawData);
                // 只有从左侧拖拽的人员块（source !== 'right'）或者是已经在右侧但想换板块的人员块
                if (dragData.name) {
                    // 如果是从右侧拖过来的，先从原处移除
                    if (dragData.source === 'right') {
                        const fromDateKey = getDateKey(dragData.fromIndex);
                        const list = taskData.rightPersonMap[fromDateKey][dragData.sectionId];
                        const idx = list.findIndex(p => (typeof p === 'string' ? p : p.name) === dragData.name);
                        if (idx !== -1) {
                            list.splice(idx, 1);
                        }
                    }
                    // 调用带初始人员名称的 addSection
                    addSection(index, dragData.name);
                }
            });

            area.appendChild(addSectionBtn);
        });
        initDragDrop();
    }

    function createPersonCard(personObj, dateIndex, sectionId, personIndex) {
        const name = typeof personObj === 'string' ? personObj : personObj.name;
        const todos = personObj.todos || [];
        const isExpanded = personObj.isExpanded || false;
        
        const card = document.createElement('div');
        card.className = `person-card ${isExpanded ? 'expanded' : ''}`;
        card.draggable = true;
        card.dataset.name = name;
        card.dataset.sourceDateIndex = dateIndex;
        card.dataset.sectionId = sectionId;
        card.dataset.sourceIndex = personIndex; // 记录在数组中的索引
        card.dataset.source = 'right';
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragend', handleDragEnd);

        const header = document.createElement('div');
        header.className = 'person-card-header';
        header.style.background = getColorForName(name);
        
        const title = document.createElement('div');
        title.className = 'person-card-title';
        title.textContent = name;
        
        const doneCount = todos.filter(t => t.done).length;
        const counter = document.createElement('span');
        counter.className = 'todo-counter';
        counter.textContent = `${doneCount}/${todos.length}`;
        
        header.appendChild(title);
        header.appendChild(counter);
        card.appendChild(header);

        const content = document.createElement('div');
        content.className = 'person-card-content';

        todos.forEach((todo, todoIndex) => {
            const item = document.createElement('div');
            item.className = 'todo-item';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'todo-checkbox';
            checkbox.checked = todo.done;
            checkbox.onchange = () => {
                todo.done = checkbox.checked;
                saveToStorage();
                renderRight();
            };
            const text = document.createElement('span');
            text.className = `todo-text ${todo.done ? 'done' : ''}`;
            text.textContent = todo.text;
            const delTodoBtn = document.createElement('button');
            delTodoBtn.className = 'btn-remove-todo';
            delTodoBtn.textContent = '×';
            delTodoBtn.onclick = () => {
                todos.splice(todoIndex, 1);
                saveToStorage();
                renderRight();
            };
            item.appendChild(checkbox);
            item.appendChild(text);
            item.appendChild(delTodoBtn);
            content.appendChild(item);
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'btn-add-todo';
        addBtn.textContent = '+ 添加待办';
        addBtn.onclick = () => addTodo(dateIndex, sectionId, personIndex);
        content.appendChild(addBtn);

        card.appendChild(content);
        return card;
    }

    let currentTodoTarget = { type: '', dateIndex: -1, sectionId: '', personIndex: -1 };
    let currentSectionTarget = { dateIndex: -1, initialPersonName: null };

    function addGlobalTodo(dateIndex, sectionId) {
        currentTodoTarget = { type: 'global', dateIndex, sectionId };
        showTodoModal('添加任务说明');
    }

    function addTodo(dateIndex, sectionId, personIndex) {
        currentTodoTarget = { type: 'person', dateIndex, sectionId, personIndex };
        showTodoModal('添加待办事项');
    }

    function showTodoModal(title) {
        const modal = document.getElementById('todo-modal');
        const input = document.getElementById('todo-manual-input');
        const tagsContainer = document.getElementById('todo-preset-tags');
        document.getElementById('todo-modal-title').textContent = title;
        input.value = '';
        modal.style.display = 'block';
        tagsContainer.innerHTML = '';
        const presets = currentTodoTarget.type === 'global' ? taskData.taskPresets : taskData.todoPresets;
        presets.forEach(text => {
            const tag = document.createElement('div');
            tag.className = 'preset-tag';
            tag.textContent = text;
            tag.onclick = () => { saveTodo(text); closeTodoModal(); };
            tagsContainer.appendChild(tag);
        });
        input.focus();
    }

    function closeTodoModal() { document.getElementById('todo-modal').style.display = 'none'; }
    function confirmManualTodo() {
        const text = document.getElementById('todo-manual-input').value.trim();
        if (text) { saveTodo(text); closeTodoModal(); }
    }

    function saveTodo(text) {
        const { type, dateIndex, sectionId, personIndex } = currentTodoTarget;
        if (dateIndex === -1) return; // 基础校验
        
        const dateKey = getDateKey(dateIndex);
        
        try {
            if (type === 'global') {
                if (!taskData.taskSections[dateKey]) return;
                const section = taskData.taskSections[dateKey].find(s => s.id === sectionId);
                if (section) {
                    section.todos.push({ text, done: false });
                }
            } else {
                if (!taskData.rightPersonMap[dateKey] || !taskData.rightPersonMap[dateKey][sectionId]) return;
                const person = taskData.rightPersonMap[dateKey][sectionId][personIndex];
                if (person) {
                    if (!person.todos) person.todos = [];
                    person.todos.push({ text, done: false });
                }
            }
            saveToStorage();
            renderRight();
        } catch (e) {
            console.error('保存待办失败:', e);
        }
    }

    function addSection(dateIndex, initialPersonName = null) {
        currentSectionTarget = { dateIndex, initialPersonName };
        const modal = document.getElementById('section-modal');
        const input = document.getElementById('section-manual-input');
        const tagsContainer = document.getElementById('section-preset-tags');
        
        input.value = '';
        modal.style.display = 'block';
        tagsContainer.innerHTML = '';
        
        taskData.sectionPresets.forEach(text => {
            const tag = document.createElement('div');
            tag.className = 'preset-tag';
            tag.textContent = text;
            tag.onclick = () => { saveSection(text); closeSectionModal(); };
            tagsContainer.appendChild(tag);
        });
        input.focus();
    }

    function closeSectionModal() { document.getElementById('section-modal').style.display = 'none'; }
    function confirmManualSection() {
        const text = document.getElementById('section-manual-input').value.trim();
        if (text) { saveSection(text); closeSectionModal(); }
    }

    function saveSection(title) {
        const { dateIndex, initialPersonName } = currentSectionTarget;
        const sectionId = 'section-' + Date.now();
        const dateKey = getDateKey(dateIndex);
        
        // 创建新板块
        if (!taskData.taskSections[dateKey]) taskData.taskSections[dateKey] = [];
        taskData.taskSections[dateKey].push({
            id: sectionId,
            title: title,
            todos: [],
            isExpanded: true
        });

        if (!taskData.rightPersonMap[dateKey]) {
            taskData.rightPersonMap[dateKey] = {};
        }
        taskData.rightPersonMap[dateKey][sectionId] = [];

        // 如果有初始人员，则添加到该板块
        if (initialPersonName) {
            // 检查人员是否已经在当天的其他板块中
            if (!isDisabled(initialPersonName, dateIndex)) {
                taskData.rightPersonMap[dateKey][sectionId].push({
                    name: initialPersonName,
                    todos: [],
                    isExpanded: true
                });
            }
        }
        
        saveToStorage();
        renderRight();
        renderLeft();
    }

    window.toggleExpandAll = (dateIndex, type) => {
        const dateKey = getDateKey(dateIndex);
        const sections = taskData.taskSections[dateKey] || [];
        if (type === 'task') {
            const anyCollapsed = sections.some(s => !s.isExpanded);
            sections.forEach(s => s.isExpanded = anyCollapsed);
        } else {
            // type === 'todo' refers to expanding all person cards in all sections of that day
            const anyCollapsed = Object.values(taskData.rightPersonMap[dateKey] || {}).some(list => list.some(p => !p.isExpanded));
            Object.values(taskData.rightPersonMap[dateKey] || {}).forEach(list => {
                list.forEach(p => p.isExpanded = anyCollapsed);
            });
        }
        saveToStorage();
        renderRight();
    };

    function deleteSection(dateIndex, sectionId) {
        if (confirm('确定要删除这个任务板块吗？该板块下的所有人员安排也将被移除。')) {
            const dateKey = getDateKey(dateIndex);
            const sections = taskData.taskSections[dateKey];
            if (!sections) return;
            
            const idx = sections.findIndex(s => s.id === sectionId);
            if (idx !== -1) {
                sections.splice(idx, 1);
                if (taskData.rightPersonMap[dateKey]) {
                    delete taskData.rightPersonMap[dateKey][sectionId];
                }
                saveToStorage();
                renderRight();
                renderLeft();
            }
        }
    }

    function isDisabled(name, dateIndex) {
        const dateKey = getDateKey(dateIndex);
        const sectionsMap = taskData.rightPersonMap[dateKey] || {};
        return Object.values(sectionsMap).some(list => list.some(p => (typeof p === 'string' ? p : p.name) === name));
    }

    function handleDragStart(e) {
        const target = e.target.closest('.name-block, .person-card');
        if (!target) return;
        
        target.classList.add('dragging');
        const dragData = {
            name: target.dataset.name,
            source: target.dataset.source,
            fromIndex: parseInt(target.dataset.dateIndex || target.dataset.sourceDateIndex),
            sectionId: target.dataset.sectionId || '',
            sourceIndex: target.dataset.sourceIndex || ''
        };
        e.dataTransfer.setData('text/plain', JSON.stringify(dragData));

        // 如果是从右边拖拽，显示顶部移除区域
        if (dragData.source === 'right') {
            const removeArea = document.getElementById('drop-remove-area');
            if (removeArea) removeArea.classList.add('active');
        }
    }

    function handleDragEnd(e) {
        e.target.classList.remove('dragging');
        document.querySelectorAll('.task-section-assigned').forEach(el => el.classList.remove('drag-over'));
        
        // 隐藏顶部移除区域
        const removeArea = document.getElementById('drop-remove-area');
        if (removeArea) {
            removeArea.classList.remove('active', 'drag-over');
        }
    }

    function initDragDrop() {
        // 顶部移除区域的事件
        const removeArea = document.getElementById('drop-remove-area');
        if (removeArea) {
            removeArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                removeArea.classList.add('drag-over');
            });
            removeArea.addEventListener('dragleave', () => removeArea.classList.remove('drag-over'));
            removeArea.addEventListener('drop', (e) => {
                e.preventDefault();
                removeArea.classList.remove('drag-over', 'active');
                const rawData = e.dataTransfer.getData('text/plain');
                if (!rawData) return;
                const { name, source, fromIndex, sectionId } = JSON.parse(rawData);

                if (source === 'right') {
                    const fromDateKey = getDateKey(fromIndex);
                    const list = taskData.rightPersonMap[fromDateKey][sectionId];
                    const idx = list.findIndex(p => (typeof p === 'string' ? p : p.name) === name);
                    if (idx !== -1) {
                        list.splice(idx, 1);
                        saveToStorage();
                        renderRight();
                        renderLeft();
                    }
                }
            });
        }

        document.querySelectorAll('.task-section-assigned').forEach(container => {
            container.addEventListener('dragover', (e) => {
                e.preventDefault();
                
                const assignedArea = container.closest('.assigned-area');
                if (!assignedArea) return;
                
                // 检查是否可以放置
                const rawData = e.dataTransfer.getData('text/plain');
                if (rawData) {
                    try {
                        const { name, fromIndex, source } = JSON.parse(rawData);
                        const targetDateIndex = parseInt(assignedArea.dataset.dateIndex);
                        
                        // 逻辑：如果是同一天内的拖拽，允许（跨板块移动）
                        // 如果是不同天的拖拽，且目标日期已经存在该人，则不允许
                        if (source === 'left' || fromIndex !== targetDateIndex) {
                            if (isDisabled(name, targetDateIndex)) {
                                e.dataTransfer.dropEffect = 'none';
                                return;
                            }
                        }
                    } catch(err) {}
                }
                
                container.classList.add('drag-over');
            });
            container.addEventListener('dragleave', () => container.classList.remove('drag-over'));
            container.addEventListener('drop', (e) => {
                e.preventDefault();
                container.classList.remove('drag-over');
                
                const assignedArea = container.closest('.assigned-area');
                if (!assignedArea) return;
                
                const rawData = e.dataTransfer.getData('text/plain');
                if (!rawData) return;
                const { name, source, fromIndex, sectionId: oldSectionId, sourceIndex } = JSON.parse(rawData);
                const targetDateIndex = parseInt(assignedArea.dataset.dateIndex);
                const targetSectionId = container.dataset.sectionId;

                // 最终校验逻辑：
                // 1. 同一天内跨板块拖拽：允许
                // 2. 跨天或从左侧拖拽：如果目标天已有该人，禁止并闪烁提示
                const isSameDayMove = (source === 'right' && fromIndex === targetDateIndex);
                
                if (!isSameDayMove && isDisabled(name, targetDateIndex)) {
                    // 找到当天已存在的该人卡片并闪烁
                    const dayColumn = document.querySelectorAll('.day-column')[targetDateIndex];
                    const existingCards = dayColumn.querySelectorAll(`.person-card[data-name="${name}"]`);
                    existingCards.forEach(card => {
                        card.classList.remove('flash-warning');
                        void card.offsetWidth; // 触发重绘以重新开始动画
                        card.classList.add('flash-warning');
                        setTimeout(() => card.classList.remove('flash-warning'), 1500);
                    });
                    return;
                }

                // 移除旧位置
                if (source === 'right') {
                    const fromDateKey = getDateKey(fromIndex);
                    const oldList = taskData.rightPersonMap[fromDateKey][oldSectionId];
                    const idx = oldList.findIndex(p => (typeof p === 'string' ? p : p.name) === name);
                    if (idx !== -1) oldList.splice(idx, 1);
                }

                // 添加到新位置
                const targetDateKey = getDateKey(targetDateIndex);
                if (!taskData.rightPersonMap[targetDateKey]) taskData.rightPersonMap[targetDateKey] = {};
                if (!taskData.rightPersonMap[targetDateKey][targetSectionId]) taskData.rightPersonMap[targetDateKey][targetSectionId] = [];
                
                const currentList = taskData.rightPersonMap[targetDateKey][targetSectionId];
                if (!currentList.some(p => (typeof p === 'string' ? p : p.name) === name)) {
                    currentList.push({ name, sourceIndex, todos: [], isExpanded: false });
                }

                saveToStorage();
                renderRight();
                renderLeft();
            });
        });
    }

    // --- 数据管理功能 ---
    function updateLastBackupInfo() {
        const lastBackup = localStorage.getItem('lastBackupTime');
        const infoElement = document.getElementById('last-backup-info');
        if (infoElement) {
            infoElement.textContent = lastBackup ? `最近一次导出备份时间: ${lastBackup}` : '尚未进行过导出备份';
        }
    }

    window.showDataManagement = function() {
        const modal = document.getElementById('data-modal');
        if (modal) {
            modal.style.display = 'block';
            updateLastBackupInfo();
        }
    };

    window.closeDataModal = function() {
        const modal = document.getElementById('data-modal');
        if (modal) modal.style.display = 'none';
    };

    window.exportData = function() {
        try {
            const dataStr = JSON.stringify(taskData, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const now = new Date();
            const dateStr = now.getFullYear() + 
                          String(now.getMonth() + 1).padStart(2, '0') + 
                          String(now.getDate()).padStart(2, '0') + '_' +
                          String(now.getHours()).padStart(2, '0') + 
                          String(now.getMinutes()).padStart(2, '0');
            const a = document.createElement('a');
            a.href = url;
            a.download = `task_assignment_backup_${dateStr}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            const timeStr = now.toLocaleString();
            localStorage.setItem('lastBackupTime', timeStr);
            updateLastBackupInfo();
            alert('数据已成功导出为 JSON 文件，请妥善保存。');
        } catch (error) {
            console.error('导出失败:', error);
            alert('数据导出失败，请重试。');
        }
    };

    window.triggerImport = function() {
        const input = document.getElementById('import-file-input');
        if (input) input.click();
    };

    window.resetAllData = async function() {
        if (confirm('警告：这将清空所有人员安排、预设和配置，并恢复到初始状态（全员可见）。确定继续吗？')) {
            // 重置本地数据结构
            taskData = {
                leftPersonList: [...DEFAULT_PERSONNEL],
                rightPersonMap: {},
                taskSections: {},
                taskPresets: ['早班巡检', '午间清理', '晚班移交', '周报整理'],
                todoPresets: ['日常巡检', '环境清洁', '设备维护', '文档整理', '客户接待'],
                sectionPresets: ['日常任务', '专项任务', '临时增援', '值班工作'],
                dayStates: {}
            };
            
            // 为本周初始化默认数据
            for (let i = 0; i < 5; i++) {
                const dateKey = getDateKey(i);
                const defaultSectionId = 'default-' + dateKey;
                taskData.taskSections[dateKey] = [{ id: defaultSectionId, title: '默认任务', todos: [], isExpanded: false }];
                taskData.rightPersonMap[dateKey] = { [defaultSectionId]: [] };
                taskData.dayStates[dateKey] = { isTodoExpanded: false, isTaskExpanded: false };
            }
            
            // 立即同步到云端（绕过防抖以保证即时性）
            try {
                await db.add({
                    payload: taskData,
                    time: new Date().getTime()
                });
                alert('系统已重置，正在刷新页面...');
                location.reload();
            } catch (err) {
                console.error("重置失败:", err);
                alert('重置失败，请重试');
            }
        }
    };
 
     window.importData = function(event) {
         const file = event.target.files[0];
         if (!file) return;
         if (!confirm('导入数据将覆盖当前所有安排，确定继续吗？')) {
             event.target.value = '';
             return;
         }
         const reader = new FileReader();
         reader.onload = function(e) {
             try {
                 const importedData = JSON.parse(e.target.result);
                 // 更加宽松但必要的检查
                 if (!importedData.taskSections || !importedData.leftPersonList) {
                     throw new Error('无效的数据格式');
                 }
                 taskData = importedData;
                 saveToStorage();
                 
                 // 重新运行初始化逻辑的核心部分
                 migrateDataToDateKeys();
                 renderLeft();
                 renderRight();
                 updateSidebarDateDisplay();
                 
                 alert('数据导入成功！');
                 window.closeDataModal();
             } catch (error) {
                 console.error('导入失败:', error);
                 alert('数据导入失败：文件格式不正确或已损坏。');
             } finally {
                 event.target.value = '';
             }
         };
         reader.readAsText(file);
     };

    window.toggleSidebar = () => { 
        sidebar.classList.toggle('collapsed'); 
        // 切换折叠状态时，确保日期显示正确更新
        updateSidebarDateDisplay();
        renderLeft(); 
    };
    
    window.prevSidebarDate = () => { 
        if (sidebarCurrentDateIndex > 0) {
            sidebarCurrentDateIndex--;
        } else {
            // 如果是周一，切换到上一周的周五
            changeWeek(-1);
            sidebarCurrentDateIndex = 4;
        }
        updateSidebarDateDisplay(); 
        renderLeft(); 
    };
    
    window.nextSidebarDate = () => { 
        if (sidebarCurrentDateIndex < 4) {
            sidebarCurrentDateIndex++;
        } else {
            // 如果是周五，切换到下一周的周一
            changeWeek(1);
            sidebarCurrentDateIndex = 0;
        }
        updateSidebarDateDisplay(); 
        renderLeft(); 
    };
    window.confirmManualTodo = confirmManualTodo;
    window.closeTodoModal = closeTodoModal;
    window.confirmManualSection = confirmManualSection;
    window.closeSectionModal = closeSectionModal;

    window.addPerson = function() {
        const name = prompt('请输入人员名字:');
        if (name && name.trim()) {
            const trimmedName = name.trim();
            if (!taskData.leftPersonList.includes(trimmedName)) {
                taskData.leftPersonList.push(trimmedName);
                saveToStorage();
                renderLeft();
            } else {
                alert('该人员已存在！');
            }
        }
    };

    window.showDeleteDialog = function() {
        if (taskData.leftPersonList.length === 0) {
            alert('暂无人员可删除');
            return;
        }
        const name = prompt('请输入要删除的人员名字:');
        if (name && name.trim()) {
            const trimmedName = name.trim();
            const index = taskData.leftPersonList.indexOf(trimmedName);
            if (index !== -1) {
                if (confirm(`确定要删除人员 "${trimmedName}" 吗？`)) {
                    taskData.leftPersonList.splice(index, 1);
                    saveToStorage();
                    renderLeft();
                    renderRight();
                }
            } else {
                alert('未找到该人员');
            }
        }
    };

    let currentPresetType = 'task';

    window.managePresets = function(type) {
        currentPresetType = type;
        const modal = document.getElementById('preset-modal');
        const title = modal.querySelector('h3');
        const input = document.getElementById('new-preset-input');
        const list = document.getElementById('modal-preset-list');
        
        if (type === 'task') title.textContent = '任务预设管理';
        else if (type === 'todo') title.textContent = '代办预设管理';
        else title.textContent = '板块预设管理';

        input.value = '';
        list.innerHTML = '';
        
        let presets;
        if (type === 'task') presets = taskData.taskPresets;
        else if (type === 'todo') presets = taskData.todoPresets;
        else presets = taskData.sectionPresets;

        presets.forEach((text, index) => {
            const item = document.createElement('div');
            item.className = 'preset-item';
            item.innerHTML = `
                <span>${text}</span>
                <button class="btn-delete-preset" onclick="deletePreset(${index})">×</button>
            `;
            list.appendChild(item);
        });
        
        modal.style.display = 'block';
        input.focus();
    };

    window.closePresetModal = function() {
        document.getElementById('preset-modal').style.display = 'none';
    };

    window.addPreset = function() {
        const input = document.getElementById('new-preset-input');
        const text = input.value.trim();
        if (text) {
            let presets;
            if (currentPresetType === 'task') presets = taskData.taskPresets;
            else if (currentPresetType === 'todo') presets = taskData.todoPresets;
            else presets = taskData.sectionPresets;

            if (!presets.includes(text)) {
                presets.push(text);
                saveToStorage();
                managePresets(currentPresetType);
            } else {
                alert('该预设已存在！');
            }
        }
    };

    window.deletePreset = function(index) {
        let presets;
        if (currentPresetType === 'task') presets = taskData.taskPresets;
        else if (currentPresetType === 'todo') presets = taskData.todoPresets;
        else presets = taskData.sectionPresets;

        if (confirm('确定要删除这个预设吗？')) {
            presets.splice(index, 1);
            saveToStorage();
            managePresets(currentPresetType);
        }
    };

    init();
});