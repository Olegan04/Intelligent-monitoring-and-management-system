// js/dashboard.js

let currentUserRole = null;
let consumptionChart;
let currentAddressId = null;
let userAddresses = [];
let allCities = [];
let allUserDevices = [];   
let devicesForCurrentAddress = [];
let selectedDevices = new Set();

document.addEventListener('DOMContentLoaded', async () => {
    if (!authToken) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const userInfo = await getCurrentUser();
        currentUserRole = userInfo.role;
        localStorage.setItem('role', currentUserRole);
    } catch (error) {
        console.error('Ошибка загрузки роли пользователя:', error);
        currentUserRole = 'user';
    }
    
    if (currentUserRole === 'admin') {
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'flex');
    }
    
    await loadAllCities();
    
    const today = new Date();
    const monthAgo = new Date();
    monthAgo.setDate(today.getDate() - 30);
    
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    if (dateFrom) dateFrom.value = monthAgo.toISOString().split('T')[0];
    if (dateTo) dateTo.value = today.toISOString().split('T')[0];
    
    if (dateFrom) dateFrom.addEventListener('change', handleDateChange);
    if (dateTo) dateTo.addEventListener('change', handleDateChange);
    
    await loadUserAddresses();
    
    // Навигация
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.dataset.page;
            if (page === 'admin' && currentUserRole !== 'admin') {
                alert('Доступ запрещён');
                return;
            }
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
            item.classList.add('active');
            document.getElementById(`${item.dataset.page}Page`).classList.add('active');
            const titles = { dashboard: 'Дашборд', devices: 'Мои устройства', addresses: 'Мои адреса', admin: 'Администрирование' };
            document.getElementById('pageTitle').textContent = titles[item.dataset.page] || 'Страница';
            if (item.dataset.page === 'devices') loadDevicesList();
            if (item.dataset.page === 'addresses') loadAddresses();
            if (item.dataset.page === 'admin' && currentUserRole === 'admin') {
                loadAdminDevices();
                loadUsersList();
            }
        });
    });

    // Мобильное меню
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.querySelector('.sidebar');
    if (mobileBtn && sidebar) {
        mobileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('open');
        });

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                if (window.innerWidth <= 768) {
                    sidebar.classList.remove('open');
                }
            });
        });

        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) {
                const isClickInsideSidebar = sidebar.contains(e.target);
                const isClickOnBurger = mobileBtn.contains(e.target);
                if (!isClickInsideSidebar && !isClickOnBurger) {
                    sidebar.classList.remove('open');
                }
            }
        });
    }
    
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    document.getElementById('updateStats')?.addEventListener('click', handleDateChange);
    
    document.getElementById('resetDeviceView')?.addEventListener('click', async () => {
        document.getElementById('resetDeviceView').style.display = 'none';
        document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.stat-card').forEach(card => card.style.border = 'none');
        await updateDashboardCards();
        await updateChartForCurrentAddressType();
        const ctx = document.getElementById('consumptionChart')?.getContext('2d');
        if (ctx && consumptionChart) consumptionChart.destroy();
        if (ctx) {
            consumptionChart = new Chart(ctx, {
                type: 'line',
                data: { labels: ['Выберите тип или устройство'], datasets: [{ label: 'Потребление', data: [0], borderColor: '#667eea', fill: false }] },
                options: { responsive: true, maintainAspectRatio: false }
            });
        }
    });

    document.getElementById('compareDevicesBtn')?.addEventListener('click', async () => {
        if (selectedDevices.size < 2) {
            alert('❌ Выберите хотя бы два устройства для сравнения (чекбоксы в списке устройств)');
            return;
        }
        const today = new Date();
        const monthAgo = new Date();
        monthAgo.setDate(today.getDate() - 30);
        document.getElementById('compareDateFrom').value = monthAgo.toISOString().split('T')[0];
        document.getElementById('compareDateTo').value = today.toISOString().split('T')[0];
        document.getElementById('compareDevicesModal').style.display = 'flex';
    });

    document.getElementById('btnBuildCompareChart')?.addEventListener('click', async () => {
        const from = document.getElementById('compareDateFrom').value;
        const to = document.getElementById('compareDateTo').value;
        if (!from || !to) {
            alert('❌ Укажите период');
            return;
        }

        const selected = Array.from(selectedDevices)
            .map(id => allUserDevices.find(d => d.id === id))
            .filter(d => d);
        if (selected.length < 2) return;

        const firstType = selected[0].type;
        if (!selected.every(d => d.type === firstType)) {
            alert('❌ Можно сравнивать только устройства одного типа');
            return;
        }

        const datasets = [];
        const colorPalette = ['#667eea', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#3498db'];
        let globalLabels = [];

        for (let idx = 0; idx < selected.length; idx++) {
            const device = selected[idx];
            const readings = await getCounterReadings(device.id, from, to);
            if (!readings || readings.length < 1) continue;

            readings.sort((a, b) => new Date(a.date) - new Date(b.date));

            const dailyValues = new Map();
            for (const r of readings) {
                const day = new Date(r.date).toISOString().split('T')[0];
                if (!dailyValues.has(day)) dailyValues.set(day, []);
                dailyValues.get(day).push(r.value);
            }

            const sortedDays = Array.from(dailyValues.keys()).sort();
            const dailyConsumption = [];
            
            for (const day of sortedDays) {
                const values = dailyValues.get(day);
                if (values.length === 1) {
                    dailyConsumption.push(values[0]);
                } else {
                    let dayTotal = 0;
                    for (let i = 1; i < values.length; i++) {
                        const diff = values[i] - values[i-1];
                        if (diff > 0) dayTotal += diff;
                    }
                    dailyConsumption.push(dayTotal);
                }
            }

            if (dailyConsumption.length === 0) continue;

            for (let i = 0; i < dailyConsumption.length; i++) {
                const values = dailyValues.get(sortedDays[i]);
                if (dailyConsumption[i] === 0 && values.length > 1 && values[values.length-1] > values[0]) {
                    dailyConsumption[i] = values[values.length-1] - values[0];
                }
            }

            if (globalLabels.length === 0) {
                globalLabels = sortedDays.map(d => new Date(d).toLocaleDateString());
            }

            datasets.push({
                label: device.addressText || `Счётчик #${device.id} (${device.type})`,
                data: dailyConsumption,
                borderColor: colorPalette[idx % colorPalette.length],
                fill: false,
                tension: 0.4
            });
        }

        if (datasets.length < 2) {
            alert('❌ Недостаточно данных для построения графика');
            return;
        }

        const canvas = document.getElementById('compareDevicesChart');
        if (!canvas) return;

        if (window.compareChart) window.compareChart.destroy();
        const ctx = canvas.getContext('2d');
        window.compareChart = new Chart(ctx, {
            type: 'line',
            data: { labels: globalLabels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'top' } },
                scales: {
                    y: { title: { display: true, text: 'Потребление' }, beginAtZero: true },
                    x: { title: { display: true, text: 'Дата' } }
                }
            }
        });
    });

    document.getElementById('clearCompareDates')?.addEventListener('click', () => {
        const now = new Date();
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        document.getElementById('compareDateFrom').value = startOfYear.toISOString().split('T')[0];
        document.getElementById('compareDateTo').value = now.toISOString().split('T')[0];
    });
    
    document.getElementById('resetDateRange')?.addEventListener('click', async () => {
        const now = new Date();
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        const from = startOfYear.toISOString().split('T')[0];
        const to = now.toISOString().split('T')[0];
        document.getElementById('dateFrom').value = from;
        document.getElementById('dateTo').value = to;
        await handleDateChange();
    });

    // Кнопка загрузки пользователей
    const loadUsersBtn = document.getElementById('loadUsersBtn');
    if (loadUsersBtn) {
        loadUsersBtn.addEventListener('click', async () => {
            console.log('Кнопка загрузить нажата');
            await loadUsersList();
        });
    }
    
    setupModals();
    setupAddressFormAutocomplete();
    
    if (userAddresses.length > 0) {
        currentAddressId = userAddresses[0].id;
        await loadDevicesForCurrentAddress();
        await loadDevicesList();
        await updateDashboardCards();
        await updateChartForCurrentAddressType();

        if (currentUserRole === 'admin') {
            await loadAdminDevices();
            await loadUsersList();
        }
    }
});

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

async function handleDateChange() {
    if (currentAddressId) {
        await updateChartForCurrentAddressType();
    }
}

async function loadAllCities() {
    try {
        allCities = await getCities();
    } catch (error) {
        console.error(error);
        allCities = [];
    }
}

async function loadUserAddresses() {
    try {
        let addresses = await getUserAddresses();
        if (!addresses) addresses = [];
        if (!Array.isArray(addresses)) addresses = [];
        userAddresses = addresses;
        const addressSelect = document.getElementById('addressSelect');
        if (addressSelect && userAddresses.length > 0) {
            addressSelect.innerHTML = userAddresses.map(addr => 
                `<option value="${addr.id}">${addr.city}, ул. ${addr.street}, д. ${addr.house}, кв. ${addr.flat}</option>`
            ).join('');
            const newSelect = addressSelect.cloneNode(true);
            addressSelect.parentNode.replaceChild(newSelect, addressSelect);
            newSelect.addEventListener('change', async (e) => {
                currentAddressId = parseInt(e.target.value);
                document.getElementById('resetDeviceView').style.display = 'none';
                await loadDevicesForCurrentAddress();
                await updateDashboardCards();
                await updateChartForCurrentAddressType();
            });
            document.getElementById('addressSelector').style.display = 'flex';
        } else if (addressSelect) {
            document.getElementById('addressSelector').style.display = 'none';
        }
        const noAddressMsg = document.getElementById('noAddressMessage');
        if (noAddressMsg) {
            noAddressMsg.style.display = userAddresses.length === 0 ? 'block' : 'none';
        }
    } catch (error) {
        console.error(error);
        userAddresses = [];
    }
}

async function loadDevicesForCurrentAddress() {
    if (!currentAddressId) {
        devicesForCurrentAddress = [];
        return;
    }
    try {
        const devices = await getUserDevicesByAddressId(currentAddressId);
        devicesForCurrentAddress = Array.isArray(devices) ? devices : [];
        renderStatsCards(devicesForCurrentAddress);
    } catch (error) {
        console.error(error);
        devicesForCurrentAddress = [];
    }
}

function setupAddressFormAutocomplete() {
    const cityInput = document.getElementById('addressCity');
    if (cityInput) {
        cityInput.addEventListener('input', (e) => {
            const value = e.target.value.toLowerCase();
            const datalist = document.getElementById('cityDatalist');
            if (datalist) {
                const filtered = allCities.filter(c => c.toLowerCase().includes(value));
                datalist.innerHTML = filtered.map(c => `<option value="${c}">`).join('');
            }
        });
    }
    
    const citySelect = document.getElementById('addressCity');
    const streetSelect = document.getElementById('addressStreet');
    const houseSelect = document.getElementById('addressHouse');
    const flatSelect = document.getElementById('addressFlat');
    
    if (citySelect && streetSelect) {
        citySelect.addEventListener('change', async () => {
            const city = citySelect.value;
            if (city) {
                const addresses = await getAddressesByCity(city);
                const streets = [...new Set(addresses.map(a => a.street))];
                streetSelect.innerHTML = '<option value="">Выберите улицу</option>' + 
                    streets.map(s => `<option value="${s}">${s}</option>`).join('');
                streetSelect.disabled = false;
            } else {
                streetSelect.disabled = true;
            }
        });
    }
    
    if (citySelect && streetSelect && houseSelect) {
        streetSelect.addEventListener('change', async () => {
            const city = citySelect.value;
            const street = streetSelect.value;
            if (city && street) {
                const addresses = await getAddressesByCity(city);
                const houses = [...new Set(addresses.filter(a => a.street === street).map(a => a.house))];
                houseSelect.innerHTML = '<option value="">Выберите дом</option>' + 
                    houses.map(h => `<option value="${h}">${h}</option>`).join('');
                houseSelect.disabled = false;
            } else {
                houseSelect.disabled = true;
            }
        });
    }
    
    if (citySelect && streetSelect && houseSelect && flatSelect) {
        houseSelect.addEventListener('change', async () => {
            const city = citySelect.value;
            const street = streetSelect.value;
            const house = houseSelect.value;
            if (city && street && house) {
                const addresses = await getAddressesByCity(city);
                const flats = [...new Set(addresses.filter(a => a.street === street && a.house === house).map(a => a.flat))];
                flatSelect.innerHTML = '<option value="">Выберите квартиру</option>' + 
                    flats.map(f => `<option value="${f}">${f}</option>`).join('');
                flatSelect.disabled = false;
            } else {
                flatSelect.disabled = true;
            }
        });
    }
}

async function loadDevicesList() {
    const container = document.getElementById('devicesList');
    if (!container) return;
    if (!Array.isArray(userAddresses) || userAddresses.length === 0) {
        container.innerHTML = '<div class="empty-message">Сначала добавьте адрес в разделе "Мои адреса"</div>';
        return;
    }
    try {
        const groups = [];
        for (const addr of userAddresses) {
            const devices = await getUserDevicesByAddressId(addr.id);
            if (devices && devices.length) {
                groups.push({ address: addr, devices });
            }
        }
        if (groups.length === 0) {
            container.innerHTML = '<div class="empty-message">Нет зарегистрированных счётчиков</div>';
            return;
        }
        let html = '';
        for (const group of groups) {
            const addr = group.address;
            html += `
                <div class="address-group">
                    <div class="address-group-title">
                        <i class="fas fa-map-marker-alt"></i> 
                        <strong>${addr.city}, ул. ${addr.street}, д. ${addr.house}, кв. ${addr.flat}</strong>
                    </div>
                    <div class="devices-list-inner">
            `;
            for (const device of group.devices) {
                device.addressText = `${addr.city}, ул. ${addr.street}, д. ${addr.house}, кв. ${addr.flat}`;
                const state = device.state || 'off';
                const statusText = state === 'on' ? 'Включено' : state === 'off' ? 'Выключено' : 'Недоступно';
                const statusClass = state === 'on' ? 'status-on' : state === 'off' ? 'status-off' : 'status-unavailable';
                const action = state === 'on' ? 'off' : 'on';
                const actionText = state === 'on' ? 'Выключить' : 'Включить';
                html += `
                    <div class="device-card" data-device-id="${device.id}" data-device-type="${device.type}">
                        <div class="device-checkbox-wrapper">
                            <input type="checkbox" class="device-checkbox" data-id="${device.id}">
                        </div>
                        <div class="device-info">
                            <strong>Счётчик #${device.id}</strong>
                            <span class="device-type">${device.type}</span>
                            <span class="device-status ${statusClass}">${statusText}</span>
                        </div>
                        <button class="btn-secondary toggle-device" data-id="${device.id}" data-action="${action}">${actionText}</button>
                    </div>
                `;
                allUserDevices.push(device);
            }
            html += `</div></div>`;
        }
        container.innerHTML = html;
        allUserDevices = groups.flatMap(g => g.devices);
        
        document.querySelectorAll('.device-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const id = parseInt(e.target.dataset.id);
                if (e.target.checked) selectedDevices.add(id);
                else selectedDevices.delete(id);
            });
        });
        
        document.querySelectorAll('.toggle-device').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.id);
                const action = btn.dataset.action;
                await toggleDevice(id, action);
            });
        });
        
        document.querySelectorAll('.device-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.classList.contains('toggle-device') || e.target.classList.contains('device-checkbox')) return;
                document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
            });
        });
    } catch (error) {
        console.error(error);
        container.innerHTML = '<div class="error-message">Ошибка загрузки устройств</div>';
    }
}

function renderStatsCards(devices) {
    const statsGrid = document.querySelector('.stats-grid');
    if (!statsGrid) return;
    const typeConfig = {
        'Электричество': { icon: 'fa-bolt', unit: 'кВт·ч', color: '#667eea' },
        'Горячая вода': { icon: 'fa-water', unit: 'м³', color: '#f093fb' },
        'Холодная вода': { icon: 'fa-snowflake', unit: 'м³', color: '#4facfe' },
        'Тепло': { icon: 'fa-fire', unit: 'Гкал', color: '#ff9800' },
        'Газ': { icon: 'fa-fire', unit: 'м³', color: '#ff5722' }
    };
    const types = [...new Set(devices.map(d => d.type))];
    if (types.length === 0) {
        statsGrid.innerHTML = '<div class="empty-message">Нет данных для отображения</div>';
        return;
    }
    statsGrid.innerHTML = types.map(type => {
        const config = typeConfig[type] || { icon: 'fa-chart-line', unit: '', color: '#667eea' };
        const typeId = type.replace(/\s/g, '');
        return `
            <div class="stat-card" data-stat-type="${type}">
                <div class="stat-icon" style="background: linear-gradient(135deg, ${config.color}20, ${config.color}40);">
                    <i class="fas ${config.icon}" style="color: ${config.color};"></i>
                </div>
                <div class="stat-info">
                    <h3>${type}</h3>
                    <p id="total_${typeId}" class="stat-value">0</p>
                    <span>${config.unit}</span>
                </div>
            </div>
        `;
    }).join('');
    document.querySelectorAll('.stat-card').forEach(card => {
        card.addEventListener('click', async () => {
            const type = card.dataset.statType;
            await updateChartForType(type);
        });
    });
}

async function updateChartForCurrentAddressType() {
    const activeCard = document.querySelector('.stat-card[style*="border"]');
    const activeType = activeCard?.dataset.statType;
    if (activeType && devicesForCurrentAddress.some(d => d.type === activeType)) {
        await updateChartForType(activeType);
    } else {
        const ctx = document.getElementById('consumptionChart')?.getContext('2d');
        if (ctx && consumptionChart) consumptionChart.destroy();
        if (ctx) {
            consumptionChart = new Chart(ctx, {
                type: 'line',
                data: { labels: ['Выберите тип'], datasets: [{ label: 'Потребление', data: [0], borderColor: '#667eea', fill: false }] },
                options: { responsive: true, maintainAspectRatio: false }
            });
        }
    }
}

async function loadLatestTotalsByType(addressId) {
    const devices = await getUserDevicesByAddressId(addressId);
    if (!devices || devices.length === 0) return {};
    const from = "2000-01-01";
    const to = new Date().toISOString().split('T')[0];
    const totals = {};
    for (const device of devices) {
        try {
            const readings = await getCounterReadings(device.id, from, to);
            if (readings && readings.length) {
                const lastValue = readings[readings.length - 1].value;
                totals[device.type] = (totals[device.type] || 0) + lastValue;
            }
        } catch (e) {}
    }
    return totals;
}

async function updateDashboardCards() {
    if (!currentAddressId) return;
    const totals = await loadLatestTotalsByType(currentAddressId);
    const map = {
        'Электричество': 'total_Электричество',
        'Горячая вода': 'total_Горячаявода',
        'Холодная вода': 'total_Холоднаявода',
        'Тепло': 'total_Тепло',
        'Газ': 'total_Газ'
    };
    for (const [type, id] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (el) el.textContent = totals[type] ?? 0;
    }
}

async function updateChartForType(type) {
    const from = document.getElementById('dateFrom')?.value;
    const to = document.getElementById('dateTo')?.value;
    const devices = devicesForCurrentAddress.filter(d => d.type === type);
    if (devices.length === 0) return;
    
    const daily = {};
    for (const device of devices) {
        const readings = await getCounterReadings(device.id, from, to);
        if (!readings || readings.length < 2) continue;
        readings.sort((a,b) => new Date(a.date) - new Date(b.date));
        for (let i=1; i<readings.length; i++) {
            const date = new Date(readings[i].date).toISOString().split('T')[0];
            const diff = readings[i].value - readings[i-1].value;
            if (diff > 0) daily[date] = (daily[date] || 0) + diff;
        }
    }
    const sorted = Object.keys(daily).sort();
    const labels = sorted.map(d => new Date(d).toLocaleDateString());
    const values = sorted.map(d => daily[d]);
    const ctx = document.getElementById('consumptionChart')?.getContext('2d');
    if (!ctx) return;
    if (consumptionChart) consumptionChart.destroy();
    const config = {
        'Электричество': { label: 'Электричество (кВт·ч)', color: '#667eea' },
        'Горячая вода': { label: 'Горячая вода (м³)', color: '#f093fb' },
        'Холодная вода': { label: 'Холодная вода (м³)', color: '#4facfe' },
        'Тепло': { label: 'Тепло (Гкал)', color: '#ff9800' },
        'Газ': { label: 'Газ (м³)', color: '#ff5722' }
    }[type] || { label: type, color: '#667eea' };
    consumptionChart = new Chart(ctx, {
        type: 'line',
        data: { labels: labels.length ? labels : ['Нет данных'], datasets: [{ label: config.label, data: values.length ? values : [0], borderColor: config.color, fill: false, tension: 0.4 }] },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, title: { display: true, text: 'Потребление' } } } }
    });
}

async function loadDevices() {
    const container = document.getElementById('devicesList');
    if (!container) return;

    if (!Array.isArray(userAddresses) || userAddresses.length === 0) {
        container.innerHTML = '<div class="empty-message">Сначала добавьте адрес в разделе "Мои адреса"</div>';
        return;
    }

    try {
        let groups = []; 
        let totalDevices = 0;

        for (const addr of userAddresses) {
            const devices = await getUserDevicesByAddressId(addr.id);
            if (devices && devices.length) {
                groups.push({ address: addr, devices });
                totalDevices += devices.length;
            }
        }

        if (totalDevices === 0) {
            container.innerHTML = '<div class="empty-message">Нет зарегистрированных счётчиков ни по одному адресу</div>';
            return;
        }

        let html = '';
        for (const group of groups) {
            const addr = group.address;
            html += `
                <div class="address-group">
                    <div class="address-group-title">
                        <i class="fas fa-map-marker-alt"></i> 
                        <strong>${addr.city}, ул. ${addr.street}, д. ${addr.house}, кв. ${addr.flat}</strong>
                    </div>
                    <div class="devices-list-inner">
            `;
            for (const device of group.devices) {
                const stateValue = device.state || 'off';
                const statusText = stateValue === 'on' ? 'Включено' : stateValue === 'off' ? 'Выключено' : 'Недоступно';
                const statusClass = stateValue === 'on' ? 'status-on' : stateValue === 'off' ? 'status-off' : 'status-unavailable';
                const action = stateValue === 'on' ? 'off' : 'on';
                const actionText = stateValue === 'on' ? 'Выключить' : 'Включить';

                html += `
                    <div class="device-card" data-device-id="${device.id}" data-device-type="${device.type}">
                        <div class="device-checkbox-wrapper">
                            <input type="checkbox" class="device-checkbox" data-id="${device.id}" data-type="${device.type}">
                        </div>
                        <div class="device-info">
                            <strong>Счётчик #${device.id}</strong>
                            <span class="device-type">${device.type}</span>
                            <span class="device-status ${statusClass}">${statusText}</span>
                        </div>
                        <button class="btn-secondary toggle-device" data-id="${device.id}" data-action="${action}">${actionText}</button>
                    </div>
                `;
            }
            html += `</div></div>`;
        }
        container.innerHTML = html;

        userDevices = groups.flatMap(g => g.devices);

        document.querySelectorAll('.device-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const deviceId = parseInt(e.target.dataset.id);
                if (e.target.checked) selectedDevices.add(deviceId);
                else selectedDevices.delete(deviceId);
            });
        });

        document.querySelectorAll('.toggle-device').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const deviceId = parseInt(btn.dataset.id);
                const action = btn.dataset.action;
                await toggleDevice(deviceId, action);
            });
        });

        document.querySelectorAll('.device-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.classList.contains('toggle-device') || e.target.classList.contains('device-checkbox')) return;
                const deviceId = parseInt(card.dataset.deviceId);
                updateChartForDevice(deviceId);
                document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const resetBtn = document.getElementById('resetDeviceView');
                if (resetBtn) resetBtn.style.display = 'inline-block';
            });
        });

        renderStatsCards(userDevices);
        await updateDashboardCards();

    } catch (error) {
        console.error('Ошибка загрузки устройств:', error);
        container.innerHTML = '<div class="error-message">Ошибка загрузки устройств</div>';
    }
}

async function toggleDevice(deviceId, action) {
    try {
        await sendCommand({ id_counter: deviceId, action, status: 'pending' });
        await new Promise(resolve => setTimeout(resolve, 500));
        await loadDevices();
    } catch (error) {
        console.error('Ошибка отправки команды:', error);
        alert('Не удалось отправить команду');
    }
}

async function loadAddresses() {
    try {
        const addresses = await getUserAddresses();
        const container = document.getElementById('addressesList');
        if (!container) return;
        if (!addresses || addresses.length === 0) {
            container.innerHTML = '<div class="empty-message">Нет добавленных адресов</div>';
        } else {
            container.innerHTML = addresses.map(addr => `
                <div class="address-card">
                    <div><strong>${addr.city}, ул. ${addr.street}, д. ${addr.house}, кв. ${addr.flat}</strong></div>
                    <i class="fas fa-check-circle" style="color: #4caf50;"></i>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки адресов:', error);
    }
}

function setupModals() {
    const modals = document.querySelectorAll('.modal');
    const closeBtns = document.querySelectorAll('.close');
    
    document.getElementById('addAddressBtn')?.addEventListener('click', () => {
        document.getElementById('addressModal').style.display = 'flex';
    });
    
    closeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = btn.closest('.modal');
            modal.style.display = 'none';
            if (modal.id === 'compareDevicesModal' && window.compareChart) {
                window.compareChart.destroy();
                window.compareChart = null;
            }
        });
    });

    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            e.target.style.display = 'none';
            if (e.target.id === 'compareDevicesModal' && window.compareChart) {
                window.compareChart.destroy();
                window.compareChart = null;
            }
        }
    });
    
    document.getElementById('addAddressForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const city = document.getElementById('addressCity').value;
        const street = document.getElementById('addressStreet').value;
        const house = document.getElementById('addressHouse').value;
        const flat = parseInt(document.getElementById('addressFlat').value);
        const address = { city, street, house, flat };
        const errorDiv = document.getElementById('addressModalError');
        
        try {
            await addAddress(address);
            document.getElementById('addressModal').style.display = 'none';
            document.getElementById('addAddressForm').reset();
            document.getElementById('addressStreet').innerHTML = '<option value="">Сначала выберите город</option>';
            document.getElementById('addressStreet').disabled = true;
            document.getElementById('addressHouse').innerHTML = '<option value="">Сначала выберите улицу</option>';
            document.getElementById('addressHouse').disabled = true;
            document.getElementById('addressFlat').innerHTML = '<option value="">Сначала выберите дом</option>';
            document.getElementById('addressFlat').disabled = true;
            await loadUserAddresses();
            await loadAddresses();
            if (userAddresses.length > 0) {
                currentAddressId = userAddresses[0].id;
                await loadDevices();
                await updateDashboardCards();
            }
        } catch (error) {
            let errorMessage = 'Ошибка добавления адреса';
            if (error.message) errorMessage = error.message;
            else if (typeof error === 'string') errorMessage = error;
            errorDiv.textContent = errorMessage;
            errorDiv.style.display = 'block';
            setTimeout(() => { errorDiv.style.display = 'none'; }, 3000);
        }

        document.getElementById('saveDeviceBtn')?.addEventListener('click', async () => {
            console.log('=== КНОПКА СОХРАНЕНИЯ СРАБОТАЛА ===');
            const form = document.getElementById('addDeviceForm');
            const formData = new FormData(form);
            const device = Object.fromEntries(formData.entries());
            device.id_counter = parseInt(device.id_counter);
            device.flat = parseInt(device.flat);
            
            console.log('Отправляем устройство:', device);
            
            try {
                await addAdminDevice(device);
                alert('Счётчик успешно добавлен');
                document.getElementById('deviceModal').style.display = 'none';
                form.reset();
                if (currentUserRole === 'admin') {
                    await loadAdminDevices();
                }
            } catch (error) {
                console.error('Ошибка:', error);
                alert('Ошибка добавления устройства');
            }
        });
    });

    document.getElementById('addAdminDeviceBtn')?.addEventListener('click', () => {
        document.getElementById('deviceModal').style.display = 'flex';
    });
}

window.saveDevice = async function() {
    console.log('=== saveDevice вызвана ===');
    
    const form = document.getElementById('addDeviceForm');
    if (!form) {
        console.error('Форма addDeviceForm не найдена');
        alert('Ошибка: форма не найдена');
        return;
    }
    
    const formData = new FormData(form);
    const device = Object.fromEntries(formData.entries());
    device.id_counter = parseInt(device.id_counter);
    device.flat = parseInt(device.flat);
    if (device.duration) {
        device.duration = new Date(device.duration).toISOString();
    }
    
    console.log('Отправляем устройство:', device);
    
    try {
        const result = await addAdminDevice(device);
        console.log('Результат:', result);
        alert('Счётчик успешно добавлен');
        document.getElementById('deviceModal').style.display = 'none';
        form.reset();
        if (typeof currentUserRole !== 'undefined' && currentUserRole === 'admin') {
            await loadAdminDevices();
        }
    } catch (error) {
        console.error('Ошибка:', error);
        let errorMsg = error.message || 'Неизвестная ошибка';
        if (error.message && error.message.includes('Conflict')) {
            errorMsg = 'Счётчик с таким ID уже существует';
        }
        alert('Ошибка добавления устройства: ' + errorMsg);
    }
};

// АДМИНИСТРАТИВНЫЕ ФУНКЦИИ
async function loadAdminDevices() {
    const container = document.getElementById('adminDevicesList');
    if (!container) return;
    
    try {
        const devices = await getAllDevices();
        if (!devices || devices.length === 0) {
            container.innerHTML = '<div class="empty-message">Нет зарегистрированных счётчиков</div>';
            return;
        }
        
        const groups = new Map();
        for (const device of devices) {
            const addrKey = `${device.city}|${device.street}|${device.house}|${device.flat}`;
            if (!groups.has(addrKey)) {
                groups.set(addrKey, {
                    address: { city: device.city, street: device.street, house: device.house, flat: device.flat },
                    devices: []
                });
            }
            groups.get(addrKey).devices.push(device);
        }
        
        let html = '';
        for (const [, group] of groups) {
            html += `
                <div class="address-group">
                    <div class="address-group-title">
                        <i class="fas fa-map-marker-alt"></i> 
                        <strong>${group.address.city}, ул. ${group.address.street}, д. ${group.address.house}, кв. ${group.address.flat}</strong>
                    </div>
                    <div class="devices-list-inner">
            `;
            for (const device of group.devices) {
                const state = device.state || 'off';
                const statusText = state === 'on' ? 'Включено' : state === 'off' ? 'Выключено' : 'Недоступно';
                const statusClass = state === 'on' ? 'status-on' : state === 'off' ? 'status-off' : 'status-unavailable';
                html += `
                    <div class="device-card" data-device-id="${device.id}">
                        <div class="device-info">
                            <strong>Счётчик #${device.id}</strong>
                            <span class="device-type">${device.type}</span>
                            <span class="device-status ${statusClass}">${statusText}</span>
                            <span class="device-owner">(Владелец: ${device.owner_name || 'не указан'})</span>
                        </div>
                    </div>
                `;
            }
            html += `</div></div>`;
        }
        container.innerHTML = html;
    } catch (error) {
        console.error('Ошибка загрузки устройств:', error);
        container.innerHTML = '<div class="error-message">Ошибка загрузки</div>';
    }
}

async function loadUsersList() {
    const statusSelect = document.getElementById('userStatusFilter');
    const status = statusSelect?.value || 'all';
    const container = document.getElementById('usersList');
    
    if (!container) {
        console.error('Контейнер usersList НЕ НАЙДЕН!');
        return;
    }
    
    container.innerHTML = '<div class="loading">Загрузка пользователей...</div>';
    
    try {
        let users = [];
        
        if (status === 'all') {
            const regularUsers = await getUsers('user') || [];
            const adminUsers = await getUsers('admin') || [];
            users = [...regularUsers, ...adminUsers];
        } else {
            users = await getUsers(status) || [];
        }
        
        if (!users || users.length === 0) {
            container.innerHTML = '<div class="empty-message">Пользователи не найдены</div>';
            return;
        }
        
        container.innerHTML = users.map(user => `
            <div class="user-card" data-user-email="${user.email}">
                <div class="user-info">
                    <strong>${user.first_name || ''} ${user.second_name || ''}</strong>
                    <span class="user-email">${user.email}</span>
                    <span class="user-role ${user.status === 'admin' ? 'role-admin' : 'role-user'}">${user.status === 'admin' ? 'Администратор' : 'Пользователь'}</span>
                </div>
                <div class="user-actions">
                    ${user.status === 'admin' 
                        ? `<button class="btn-secondary demote-user" data-email="${user.email}">Снять права админа</button>`
                        : `<button class="btn-primary promote-user" data-email="${user.email}">Назначить админом</button>`
                    }
                </div>
            </div>
        `).join('');
        
        document.querySelectorAll('.promote-user').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await updateUserStatus(btn.dataset.email, 'admin');
                } catch (e) {
                    console.error('Ошибка:', e);
                }
                await loadUsersList();
            });
        });

        document.querySelectorAll('.demote-user').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await updateUserStatus(btn.dataset.email, 'user');
                } catch (e) {
                    console.error('Ошибка:', e);
                }
                await loadUsersList();
            });
        });
        
    } catch (error) {
        console.error('Ошибка загрузки пользователей:', error);
        container.innerHTML = '<div class="error-message">Ошибка загрузки пользователей: ' + error.message + '</div>';
    }
}

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.classList.toggle('open');
    }
}