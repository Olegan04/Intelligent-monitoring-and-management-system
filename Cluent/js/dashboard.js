// js/dashboard.js

let consumptionChart, distributionChart;
let currentAddressId = null;
let currentDeviceId = null;
let userAddresses = [];
let allCities = [];
let userDevices = [];

document.addEventListener('DOMContentLoaded', async () => {
    if (!authToken) {
        window.location.href = 'index.html';
        return;
    }
    
    await loadAllCities();
    
    const today = new Date();
    const monthAgo = new Date();
    monthAgo.setDate(today.getDate() - 30);
    
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    if (dateFrom) dateFrom.value = monthAgo.toISOString().split('T')[0];
    if (dateTo) dateTo.value = today.toISOString().split('T')[0];
    
    // ✅ Обработчики изменения дат
    if (dateFrom) {
        dateFrom.addEventListener('change', async () => {
            await handleDateChange();
        });
    }
    if (dateTo) {
        dateTo.addEventListener('change', async () => {
            await handleDateChange();
        });
    }
    
    await loadUserAddresses();
    
    // Навигация
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
            item.classList.add('active');
            document.getElementById(`${item.dataset.page}Page`).classList.add('active');
            const titles = { dashboard: 'Дашборд', devices: 'Мои устройства', addresses: 'Мои адреса', statistics: 'Статистика', commands: 'Управление' };
            document.getElementById('pageTitle').textContent = titles[item.dataset.page];
            if (item.dataset.page === 'devices') loadDevices();
            if (item.dataset.page === 'addresses') loadAddresses();
        });
    });
    
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    
    // ✅ Кнопка обновления
    document.getElementById('updateStats')?.addEventListener('click', async () => {
        console.log('Ручное обновление данных');
        await handleDateChange();
    });
    
    document.getElementById('loadStats')?.addEventListener('click', loadStatistics);
    document.getElementById('sendCommandBtn')?.addEventListener('click', sendCommandToDevice);
    document.getElementById('resetDeviceView')?.addEventListener('click', async () => {
        console.log('Сброс выбора счётчика');
        currentDeviceId = null;
        document.getElementById('resetDeviceView').style.display = 'none';
        document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.stat-card').forEach(card => {
            card.style.border = 'none';
        });
        await updateAddressTotals();
        await updateDistributionChart();
        
        const ctx1 = document.getElementById('consumptionChart')?.getContext('2d');
        if (ctx1 && consumptionChart) {
            consumptionChart.destroy();
            consumptionChart = new Chart(ctx1, {
                type: 'line',
                data: {
                    labels: ['Выберите тип или устройство'],
                    datasets: [{
                        label: 'Потребление',
                        data: [0],
                        borderColor: '#667eea',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'top' } }
                }
            });
        }
    });
    
    setupModals();
    setupAddressFormAutocomplete();
    
    if (userAddresses.length > 0) {
        currentAddressId = userAddresses[0].id;
        await loadDevices();
        await updateAddressTotals();
        await loadStatistics();
    }
});

// ✅ Функция обработки изменения дат
async function handleDateChange() {
    if (currentDeviceId) {
        await updateChartForDevice(currentDeviceId);
    } else if (currentAddressId) {
        await updateAddressTotals();
        
        const activeCard = document.querySelector('.stat-card[style*="border"]');
        const activeType = activeCard?.dataset.statType;
        if (activeType) {
            await updateChartForType(activeType);
        } else {
            await updateDistributionChart();
        }
    }
    
    await loadStatistics();
}

async function loadAllCities() {
    try {
        allCities = await getCities();
    } catch (error) {
        console.error('Ошибка загрузки городов:', error);
        allCities = [];
    }
}

async function loadUserAddresses() {
    try {
        userAddresses = await getUserAddresses();
        const addressSelect = document.getElementById('addressSelect');
        if (addressSelect && userAddresses.length > 0) {
            addressSelect.innerHTML = userAddresses.map(addr => 
                `<option value="${addr.id}">${addr.city}, ул. ${addr.street}, д. ${addr.house}, кв. ${addr.flat}</option>`
            ).join('');
            addressSelect.addEventListener('change', async (e) => {
                currentAddressId = parseInt(e.target.value);
                currentDeviceId = null;
                document.getElementById('resetDeviceView').style.display = 'none';
                await loadDevices();
                await updateAddressTotals();
                await loadStatistics();
            });
            document.getElementById('addressSelector').style.display = 'flex';
        } else if (addressSelect) {
            document.getElementById('addressSelector').style.display = 'none';
        }
        
        const noAddressMsg = document.getElementById('noAddressMessage');
        if (noAddressMsg) {
            if (userAddresses.length === 0) {
                noAddressMsg.style.display = 'block';
            } else {
                noAddressMsg.style.display = 'none';
            }
        }
        return userAddresses;
    } catch (error) {
        console.error('Ошибка загрузки адресов:', error);
        return [];
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

// Динамическое создание карточек показаний
function renderStatsCards(devices) {
    const statsGrid = document.querySelector('.stats-grid');
    if (!statsGrid) return;
    
    // Маппинг типов на иконки и единицы измерения
    const typeConfig = {
        'Электричество': { icon: 'fa-bolt', unit: 'кВт·ч', color: '#667eea' },
        'Горячая вода': { icon: 'fa-water', unit: 'м³', color: '#f093fb' },
        'Холодная вода': { icon: 'fa-snowflake', unit: 'м³', color: '#4facfe' },
        'Тепло': { icon: 'fa-fire', unit: 'Гкал', color: '#ff9800' },
        'Газ': { icon: 'fa-fire', unit: 'м³', color: '#ff5722' }
    };
    
    // Получаем уникальные типы устройств
    const types = [...new Set(devices.map(d => d.type))];
    
    if (types.length === 0) {
        statsGrid.innerHTML = '<div class="empty-message">Нет данных для отображения</div>';
        return;
    }
    
    // Создаём карточки только для существующих типов
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
    
    // Добавляем обработчики клика на карточки
    document.querySelectorAll('.stat-card').forEach(card => {
        card.addEventListener('click', async () => {
            const type = card.dataset.statType;
            if (currentDeviceId) {
                // Если выбран конкретный счётчик, сбрасываем его
                currentDeviceId = null;
                document.getElementById('resetDeviceView').style.display = 'none';
                document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
            }
            await updateChartForType(type);
        });
    });
}

// Получение суммы по типу за период
async function getTotalByType(type, from, to) {
    const devicesOfType = userDevices.filter(d => d.type === type);
    let total = 0;
    for (const device of devicesOfType) {
        try {
            const readings = await getCounterReadings(device.id, from, to);
            if (Array.isArray(readings)) {
                total += readings.reduce((sum, r) => sum + (r.value || 0), 0);
            }
        } catch (error) {
            console.error(`Ошибка загрузки для ${type}:`, error);
        }
    }
    return total;
}

// Обновление всех карточек суммами
async function updateAddressTotals() {
    if (!currentAddressId || !userDevices.length) {
        const typeIds = ['Электричество', 'Горячаявода', 'Холоднаявода', 'Тепло', 'Газ'];
        typeIds.forEach(id => {
            const el = document.getElementById(`total_${id}`);
            if (el) el.textContent = '0';
        });
        return;
    }
    
    const from = document.getElementById('dateFrom')?.value;
    const to = document.getElementById('dateTo')?.value;
    
    // Получаем уникальные типы устройств
    const types = [...new Set(userDevices.map(d => d.type))];
    
    for (const type of types) {
        const typeId = type.replace(/\s/g, '');
        const totalEl = document.getElementById(`total_${typeId}`);
        if (totalEl) {
            totalEl.textContent = '...';
            const total = await getTotalByType(type, from, to);
            totalEl.textContent = total;
        }
    }
    
    // Обновляем график распределения
    updateDistributionChart();
}

// Построение графика по типу ресурса
async function updateChartForType(type) {
    const from = document.getElementById('dateFrom')?.value;
    const to = document.getElementById('dateTo')?.value;
    
    const devicesOfType = userDevices.filter(d => d.type === type);
    if (devicesOfType.length === 0) return;
    
    let allReadings = [];
    for (const device of devicesOfType) {
        try {
            const readings = await getCounterReadings(device.id, from, to);
            if (Array.isArray(readings)) {
                allReadings = allReadings.concat(readings);
            }
        } catch (error) {
            console.error(`Ошибка загрузки для устройства ${device.id}:`, error);
        }
    }
    
    // Группируем по датам
    const groupedByDate = {};
    allReadings.forEach(r => {
        const date = new Date(r.date).toISOString().split('T')[0]; // YYYY-MM-DD для правильной сортировки
        if (!groupedByDate[date]) groupedByDate[date] = 0;
        groupedByDate[date] += r.value;
    });
    
    // ✅ СОРТИРУЕМ ДАТЫ (старые → новые)
    const sortedDates = Object.keys(groupedByDate).sort();
    const labels = sortedDates.map(d => new Date(d).toLocaleDateString());
    const values = sortedDates.map(d => groupedByDate[d]);
    
    const ctx1 = document.getElementById('consumptionChart')?.getContext('2d');
    if (!ctx1) return;
    
    if (consumptionChart) consumptionChart.destroy();
    
    const typeConfig = {
        'Электричество': { label: 'Электричество (кВт·ч)', color: '#667eea' },
        'Горячая вода': { label: 'Горячая вода (м³)', color: '#f093fb' },
        'Холодная вода': { label: 'Холодная вода (м³)', color: '#4facfe' },
        'Тепло': { label: 'Тепло (Гкал)', color: '#ff9800' },
        'Газ': { label: 'Газ (м³)', color: '#ff5722' }
    };
    const config = typeConfig[type] || { label: type, color: '#667eea' };
    
    consumptionChart = new Chart(ctx1, {
        type: 'line',
        data: {
            labels: labels.length ? labels : ['Нет данных'],
            datasets: [{
                label: config.label,
                data: values.length ? values : [0],
                borderColor: config.color,
                backgroundColor: `${config.color}20`,
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: {
                x: {
                    title: { display: true, text: 'Дата' }
                },
                y: {
                    title: { display: true, text: 'Потребление' },
                    beginAtZero: true
                }
            }
        }
    });
}

// Построение графика для конкретного счётчика
async function updateChartForDevice(deviceId) {
    const from = document.getElementById('dateFrom')?.value;
    const to = document.getElementById('dateTo')?.value;
    
    try {
        const readings = await getCounterReadings(deviceId, from, to);
        
        const device = userDevices.find(d => d.id === deviceId);
        const deviceType = device?.type || 'Счётчик';
        
        const ctx1 = document.getElementById('consumptionChart')?.getContext('2d');
        if (!ctx1) return;
        
        const readingsArray = Array.isArray(readings) ? readings : [];
        
        // ✅ СОРТИРУЕМ ПО ДАТЕ (старые → новые)
        const sortedReadings = [...readingsArray].sort((a, b) => new Date(a.date) - new Date(b.date));
        
        const labels = sortedReadings.map(r => new Date(r.date).toLocaleDateString());
        const values = sortedReadings.map(r => r.value);
        
        if (consumptionChart) consumptionChart.destroy();
        
        consumptionChart = new Chart(ctx1, {
            type: 'line',
            data: {
                labels: labels.length ? labels : ['Нет данных'],
                datasets: [{
                    label: `${deviceType} (потребление)`,
                    data: values.length ? values : [0],
                    borderColor: '#667eea',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'top' } },
                scales: {
                    x: {
                        title: { display: true, text: 'Дата' }
                    },
                    y: {
                        title: { display: true, text: 'Потребление' },
                        beginAtZero: true
                    }
                }
            }
        });
        
        const resetBtn = document.getElementById('resetDeviceView');
        if (resetBtn) resetBtn.style.display = 'inline-block';
        
        document.querySelectorAll('.stat-card').forEach(card => {
            if (card.dataset.statType === deviceType) {
                card.style.border = '2px solid #667eea';
            } else {
                card.style.border = 'none';
            }
        });
        
    } catch (error) {
        console.error('Ошибка загрузки показаний счётчика:', error);
    }
}

// Обновление круговой диаграммы распределения
function updateDistributionChart() {
    const ctx2 = document.getElementById('distributionChart')?.getContext('2d');
    if (!ctx2) return;
    
    const types = [...new Set(userDevices.map(d => d.type))];
    const from = document.getElementById('dateFrom')?.value;
    const to = document.getElementById('dateTo')?.value;
    
    // Асинхронно получаем суммы и обновляем график
    Promise.all(types.map(async type => {
        const total = await getTotalByType(type, from, to);
        return { type, total };
    })).then(results => {
        const data = results.map(r => r.total);
        const labels = results.map(r => r.type);
        const hasData = data.some(v => v > 0);
        
        const colors = {
            'Электричество': '#667eea',
            'Горячая вода': '#f093fb',
            'Холодная вода': '#4facfe',
            'Тепло': '#ff9800',
            'Газ': '#ff5722'
        };
        
        if (distributionChart) distributionChart.destroy();
        
        distributionChart = new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: hasData ? data : [1],
                    backgroundColor: hasData 
                        ? labels.map(l => colors[l] || '#667eea')
                        : ['#e0e0e0']
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                if (!hasData) return 'Нет данных';
                                return `${context.label}: ${context.raw}`;
                            }
                        }
                    }
                }
            }
        });
    });
}

async function loadDevices() {
    const container = document.getElementById('devicesList');
    if (!container) return;
    
    if (userAddresses.length === 0) {
        container.innerHTML = '<div class="empty-message">Сначала добавьте адрес в разделе "Мои адреса"</div>';
        return;
    }
    
    if (!currentAddressId) {
        container.innerHTML = '<div class="empty-message">Выберите адрес для просмотра устройств</div>';
        return;
    }
    
    try {
        const devices = await getUserDevicesByAddressId(currentAddressId);
        userDevices = Array.isArray(devices) ? devices : [];
        
        // Отрисовываем карточки показаний на основе устройств
        renderStatsCards(userDevices);
        
        if (userDevices.length === 0) {
            container.innerHTML = '<div class="empty-message">По этому адресу нет зарегистрированных счётчиков</div>';
            return;
        }
        
        let devicesHtml = '';
        
        for (const device of userDevices) {
            const statusText = device.status === 'on' ? 'Включено' : device.status === 'off' ? 'Выключено' : 'Недоступно';
            const statusClass = device.status === 'on' ? 'status-on' : device.status === 'off' ? 'status-off' : 'status-unavailable';
            const action = device.status === 'on' ? 'off' : 'on';
            const actionText = device.status === 'on' ? 'Выключить' : 'Включить';
            
            devicesHtml += `
                <div class="device-card" data-device-id="${device.id}" data-device-type="${device.type}">
                    <div>
                        <strong>Счётчик #${device.id}</strong>
                        <span class="device-type">${device.type}</span>
                        <span class="device-status ${statusClass}">${statusText}</span>
                    </div>
                    <button class="btn-secondary toggle-device" data-id="${device.id}" data-action="${action}">${actionText}</button>
                </div>
            `;
        }
        
        container.innerHTML = devicesHtml;
        
        document.querySelectorAll('.toggle-device').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const deviceId = parseInt(btn.dataset.id);
                const action = btn.dataset.action;
                await toggleDevice(deviceId, action);
            });
        });
        
        document.querySelectorAll('.device-card').forEach(card => {
            card.addEventListener('click', async () => {
                const deviceId = parseInt(card.dataset.deviceId);
                currentDeviceId = deviceId;
                await updateChartForDevice(deviceId);
                document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
            });
        });
        
        // Обновляем суммы
        await updateAddressTotals();
        
    } catch (error) {
        console.error('Ошибка загрузки устройств:', error);
        container.innerHTML = '<div class="error-message">Ошибка загрузки устройств</div>';
    }
}

async function toggleDevice(deviceId, action) {
    console.log(`Устройство ${deviceId}: ${action}`);
    try {
        await sendCommand({ id_counter: deviceId, action, status: 'pending' });
        
        const deviceCard = document.querySelector(`.device-card[data-device-id="${deviceId}"]`);
        if (deviceCard) {
            const statusSpan = deviceCard.querySelector('.device-status');
            const button = deviceCard.querySelector('.toggle-device');
            if (action === 'on') {
                statusSpan.textContent = 'Включено';
                statusSpan.className = 'device-status status-on';
                button.textContent = 'Выключить';
                button.dataset.action = 'off';
            } else {
                statusSpan.textContent = 'Выключено';
                statusSpan.className = 'device-status status-off';
                button.textContent = 'Включить';
                button.dataset.action = 'on';
            }
        }
    } catch (error) {
        console.error('Ошибка отправки команды:', error);
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

async function loadStatistics() {
    const type = document.getElementById('statType')?.value || 'country';
    const counterType = document.getElementById('counterType')?.value || 'Электричество';
    const from = document.getElementById('dateFrom')?.value;
    const to = document.getElementById('dateTo')?.value;
    
    try {
        const stats = await getUserStats(type, { from, to, type_counter: counterType });
        const tbody = document.getElementById('statsTableBody');
        if (!tbody) return;
        
        const statsArray = Array.isArray(stats) ? stats : [];
        
        if (statsArray.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4">Нет данных</td></tr>';
        } else {
            tbody.innerHTML = statsArray.map(stat => `
                <tr>
                    <td>${stat.location || stat.city || stat.street || stat.house || '-'}</td>
                    <td>${stat.total_value || 0}</td>
                    <td>${(stat.average_value || 0).toFixed(2)}</td>
                    <td>${stat.readings_count || 0}</td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки статистики:', error);
    }
}

async function sendCommandToDevice() {
    const idCounter = document.getElementById('commandCounterId')?.value;
    const action = document.getElementById('commandAction')?.value;
    const resultDiv = document.getElementById('commandResult');
    if (!idCounter) {
        if (resultDiv) resultDiv.innerHTML = '<div class="error-message">Введите ID счётчика</div>';
        return;
    }
    try {
        await sendCommand({ id_counter: parseInt(idCounter), action, status: 'pending' });
        if (resultDiv) resultDiv.innerHTML = '<div class="success-message">Команда успешно отправлена</div>';
        setTimeout(() => { if (resultDiv) resultDiv.innerHTML = ''; }, 3000);
    } catch (error) {
        if (resultDiv) resultDiv.innerHTML = '<div class="error-message">Ошибка отправки команды</div>';
    }
}

function setupModals() {
    const modals = document.querySelectorAll('.modal');
    const closeBtns = document.querySelectorAll('.close');
    
    document.getElementById('addAddressBtn')?.addEventListener('click', () => {
        document.getElementById('addressModal').style.display = 'flex';
    });
    
    closeBtns.forEach(btn => { 
        btn.addEventListener('click', () => btn.closest('.modal').style.display = 'none'); 
    });
    window.addEventListener('click', (e) => { 
        if (e.target.classList.contains('modal')) e.target.style.display = 'none'; 
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
                await updateAddressTotals();
                await loadStatistics();
            }
        } catch (error) {
            let errorMessage = 'Ошибка добавления адреса';
            if (error.message) errorMessage = error.message;
            else if (typeof error === 'string') errorMessage = error;
            errorDiv.textContent = errorMessage;
            errorDiv.style.display = 'block';
            setTimeout(() => { errorDiv.style.display = 'none'; }, 3000);
        }
    });
}