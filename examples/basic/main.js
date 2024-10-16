import * as BIKE from '../../cycling_power_ble.module.js'

const BLUETOOTH_BLUE = "#0082FC";
const DISCONNECTED_BLACK = "rgba(0,0,0, 0)";

class Graphics{
     
    static MODE = Object.freeze({
        BODY_BIKE: "body bike UI",
        GRAPHS: "graphs"
    });
    #mode = Graphics.MODE.GRAPHS;

    #minutes = 60;
    #hours = 60*this.#minutes;
    #zoneColors = ["white", "blue", "green", "yellow", "red"];

    constructor(dom){
        this.canvas = dom;
        this.windowTimeLength = 3*this.#minutes; // [s]
        this.zone = {
            heartRate: [70, 120, 150, 170, 180],
            power: [120, 200, 250, 300, 350]
        }
        this.display = {
            power: true,
            speed: true,
            cadence: true,
            pulse: true
        }
    }

    get mode(){
        return this.#mode;
    }

    setMode(mode = Graphics.MODE.GRAPHS){
        if(
            mode == Graphics.MODE.GRAPHS ||
            mode == Graphics.MODE.BODY_BIKE
        ){
            this.#mode = mode;
        }
    }

    update(){
        this.#clearScreen();
    }

    #clearScreen(){

    }
    #drawPower(powerArray, timeArray, avgPower = null, maxPower = null){

    }
    #drawSpeed(speedArray, timeArray, avgSpeed = null, maxSpeed = null){

    }
    #drawCadence(cadenceArray, timeArray, avgCadence = null, maxCadence = null){
        
    }
    #drawPulse(pulseArray, timeArray, avgPulse = null, maxPulse = null){

    }
}

let session = new BIKE.Session();

const canvas = document.getElementById("canvas");
let graphics = new Graphics(canvas);



let dataDisplayWatchdog = {
    flag: false,
    selectedMode: 'total', // 'lap'
}

let bluetoothWatchdog = {
    flag: false,
    bike: {previousConnectionState: false, name: ""},
    hr: {previousConnectionState: false, name: ""}
}

let sessionWatchdog = {
    flag: true,
    startedState: false,
    endedState: false,
    pausedState: false,
}

const startBt = document.getElementById("start");
const pauseBt = document.getElementById("pause");
const lapBt = document.getElementById("lap");
const stopBt = document.getElementById("stop");
const newBt = document.getElementById("new");
const downloadBt = document.getElementById("download");

const clockEl = document.getElementById("clock_time");
const lapTimeEl = document.getElementById("lap_time");
const totalTimeEl = document.getElementById("total_time");

const kCalAccEl = document.getElementById("kCal_acc");
const kCalAvgEl = document.getElementById("kCal_avg");
const speedEl = document.getElementById("speed");
const distanceEl = document.getElementById("distance");
const hrMaxEl = document.getElementById("heart_rate_max");
const hrAvgEl = document.getElementById("heart_rate_avg");
const cadenceMaxEl = document.getElementById("cadence_max");
const cadenceAvgEl = document.getElementById("cadence_avg")
const powerMaxEl = document.getElementById("power_max");
const powerAvgEl = document.getElementById("power_avg");

function renderer(){
    const sessionStats = session.getStats();
    const sessionDataMatrix = session.sessionData.getSessionDataAsJSON();


    // Format the time
    const currentTime = new Date();
    const hh = currentTime.getHours();
    const mm = currentTime.getMinutes();
    const ss = currentTime.getSeconds();
    let formattedTime = `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
    clockEl.innerHTML = formattedTime;
    
    if(session.started){
        const now = currentTime.getTime();
        const startTimestamp = sessionStats.startTime;
        const endTimestamp = sessionStats.endTime;
        let elapsedTime = (session.ended ? endTimestamp : now) - startTimestamp;
        formattedTime = BIKE.formatTime(elapsedTime);
        totalTimeEl.innerHTML = formattedTime;

        elapsedTime -= 1000*sessionDataMatrix.laps[sessionDataMatrix.laps.length-1];
        formattedTime = BIKE.formatTime(elapsedTime);
        lapTimeEl.innerHTML = formattedTime;
    }
    else {
        formattedTime = '--:--:--';
        totalTimeEl.innerHTML = formattedTime;
        lapTimeEl.innerHTML = formattedTime;
    }

    if(dataDisplayWatchdog.selectedMode == "total"){
        kCalAccEl.innerHTML = (sessionStats.total.energy.acc ? '--' : BIKE.Joule2Cal(sessionStats.total.energy.acc).toFixed(0)) + ' kCal';
        kCalAvgEl.innerHTML = (sessionStats.total.energy.phr ? '--' : BIKE.Joule2Cal(sessionStats.total.energy.phr).toFixed(0)) + ' kCal/h';
        speedEl.innerHTML = (sessionStats.total.speed.avg ? '--' : sessionStats.total.speed.avg.toFixed(1)) + ' km/h';
        distanceEl.innerHTML = (sessionStats.total.distance.acc ? '--' : sessionStats.total.distance.acc.toFixed(1)) + ' km';
        hrMaxEl.innerHTML = (sessionStats.total.heartRate.max ? '--' : sessionStats.total.heartRate.max.toFixed(0)) + ' MAX';
        hrAvgEl.innerHTML = (sessionStats.total.heartRate.avg ? '--' : sessionStats.total.heartRate.avg.toFixed(0)) + ' AVG';
        cadenceMaxEl.innerHTML = (sessionStats.total.cadence.max ? '--' : sessionStats.total.cadence.max.toFixed(0)) + ' MAX';
        cadenceAvgEl.innerHTML = (sessionStats.total.cadence.avg ? '--' : sessionStats.total.cadence.avg.toFixed(0)) + ' AVG';
        powerMaxEl.innerHTML = (sessionStats.total.power.max ? '--' : sessionStats.total.power.max.toFixed(0)) + ' MAX';
        powerAvgEl.innerHTML = (sessionStats.total.power.avg ? '--' : sessionStats.total.power.avg.toFixed(0)) + ' AVG';
    }
    else if(dataDisplayWatchdog.selectedMode == "lap"){
        kCalAccEl.innerHTML = (sessionStats.lap.energy.acc ? '--' : BIKE.Joule2Cal(sessionStats.lap.energy.acc).toFixed(0)) + ' kCal';
        kCalAvgEl.innerHTML = (sessionStats.lap.energy.phr ? '--' : BIKE.Joule2Cal(sessionStats.lap.energy.phr).toFixed(0)) + ' kCal/h';
        speedEl.innerHTML = (sessionStats.lap.speed.avg ? '--' : sessionStats.lap.speed.avg.toFixed(1)) + ' km/h';
        distanceEl.innerHTML = (sessionStats.lap.distance.acc ? '--' : sessionStats.lap.distance.acc.toFixed(1)) + ' km';
        hrMaxEl.innerHTML = (sessionStats.lap.heartRate.max ? '--' : sessionStats.lap.heartRate.max.toFixed(0)) + ' MAX';
        hrAvgEl.innerHTML = (sessionStats.lap.heartRate.avg ? '--' : sessionStats.lap.heartRate.avg.toFixed(0)) + ' AVG';
        cadenceMaxEl.innerHTML = (sessionStats.lap.cadence.max ? '--' : sessionStats.lap.cadence.max.toFixed(0)) + ' MAX';
        cadenceAvgEl.innerHTML = (sessionStats.lap.cadence.avg ? '--' : sessionStats.lap.cadence.avg.toFixed(0)) + ' AVG';
        powerMaxEl.innerHTML = (sessionStats.lap.power.max ? '--' : sessionStats.lap.power.max.toFixed(0)) + ' MAX';
        powerAvgEl.innerHTML = (sessionStats.lap.power.avg ? '--' : sessionStats.lap.power.avg.toFixed(0)) + ' AVG';
    }

    // graphics.setPower();
    // graphics.setSpeed();
    // graphics.setCadence();
    // graphics.setPulse();
    graphics.update();


    if (
        sessionWatchdog.flag ||
        sessionWatchdog.startedState != session.started ||
        sessionWatchdog.endedState != session.ended ||
        sessionWatchdog.pausedState != session.paused
    ){
        sessionWatchdog.flag = false;
        sessionWatchdog.startedState = session.started;
        sessionWatchdog.endedState = session.ended;
        sessionWatchdog.pausedState = session.paused;

        startBt.style.display = "none";
        pauseBt.style.display = "none";
        lapBt.style.display = "none";
        stopBt.style.display = "none";
        newBt.style.display = "none";
        downloadBt.style.display = "none";

        if(session.started && !session.ended){
            pauseBt.style.display = "flex";
            lapBt.style.display = "flex";
            stopBt.style.display = "flex";
        }
        else if(session.started && session.ended){
            newBt.style.display = "flex";
            downloadBt.style.display = "flex";
        }
        else if(!session.started){
            startBt.style.display = "flex";
        }

        if(session.paused){
            pauseBt.innerHTML = "CONTINUE";
        }
        else{
            pauseBt.innerHTML = "PAUSE";
        }
    }
    
    // graphics.something something
    if(bluetoothWatchdog.flag){
        if (
            bluetoothWatchdog.flag ||
            bluetoothWatchdog.bike.previousConnectionState != session.bike.isConnected ||
            bluetoothWatchdog.bike.name != session.bike.name
        ){
            bluetoothWatchdog.flag = false;
            bluetoothWatchdog.bike.previousConnectionState = session.bike.isConnected;
            bluetoothWatchdog.bike.name = session.bike.name;
            if(session.bike.isConnected){
                document.getElementById("ble_bike").style.backgroundColor = BLUETOOTH_BLUE;
                document.getElementById("bike_name").innerHTML = session.bike.name;
            }
            else{
                document.getElementById("ble_bike").style.backgroundColor = DISCONNECTED_BLACK;
                document.getElementById("bike_name").innerHTML = "Bike";
            }
        }
        if(
            bluetoothWatchdog.flag ||
            bluetoothWatchdog.hr.previousConnectionState != session.hr.isConnected ||
            bluetoothWatchdog.hr.name != session.hr.name
        ){
            bluetoothWatchdog.hr.previousConnectionState = session.hr.isConnected;
            bluetoothWatchdog.hr.name = session.hr.name;
            if(session.hr.isConnected){
                document.getElementById("ble_hr").style.backgroundColor = BLUETOOTH_BLUE;
                document.getElementById("hr_name").innerHTML = session.bike.name;
            }
            else{
                document.getElementById("ble_hr").style.backgroundColor = DISCONNECTED_BLACK;
                document.getElementById("hr_name").innerHTML = "Heart Rate Monitor";
            }
        }
        bluetoothWatchdog.flag = false;
    }
    requestAnimationFrame(renderer);
}
renderer();


// Menuing 
function prompt(promptContent = "info"){
    document.getElementById("prompt").style.display = "flex";

    document.getElementById("settings_prompt").style.display = promptContent == "settings" ? "flex" : "none";
    document.getElementById("info_prompt").style.display = promptContent == "info" ? "flex" : "none";

    if(
        promptContent != "settings" ||
        promptContent != "info"
    ){
        console.error("Your promptContent did not match any of the supported promptContent-options ['settings', 'info']: ", promptContent)
    }
}
document.getElementById("settings").addEventListener("click", function(){ prompt("settings"); });
document.getElementById("info").addEventListener("click", function(){ prompt("info"); });
document.getElementById("prompt_background").addEventListener("click", function(){ document.getElementById("prompt").style.display = "none"; });
document.getElementById("prompt_exit").addEventListener("click", function(){ document.getElementById("prompt").style.display = "none"; });
document.getElementById("ble_bike").addEventListener("click", function(){ session.bike.connect(); });
document.getElementById("ble_hr").addEventListener("click", function(){ session.hr.connect(); });
document.getElementById("toggle_graphics").addEventListener("click", function(){
    if(graphics.mode == Graphics.MODE.GRAPHS){
        this.innerHTML = "Graph";
        graphics.setMode(Graphics.MODE.BODY_BIKE);
    }
    else if(graphics.mode == Graphics.MODE.BODY_BIKE){
        this.innerHTML = "BODY BIKE";
        graphics.setMode(Graphics.MODE.GRAPHS);
    }
});

document.getElementById("session_data").addEventListener("click", function(){
    const tableTitleEl = document.getElementById("session_data_lap_total");
    if(dataDisplayWatchdog.selectedMode == "total"){
        dataDisplayWatchdog.selectedMode = "lap";
        tableTitleEl.innerHTML = "Lap";
    }
    else if(dataDisplayWatchdog.selectedMode == "lap"){
        dataDisplayWatchdog.selectedMode = "total";
        tableTitleEl.innerHTML = "Total";
    }   
    else {
        dataDisplayWatchdog.selectedMode = "total";
    }
});

// Session Button logic
startBt.addEventListener("click", function(){ 
    console.log("Starting Session");
    session.start(); 
});
lapBt.addEventListener("click", function(){ 
    console.log("Lapping Session");
    session.lap(); 
});
pauseBt.addEventListener("click", function(){
    if(session.paused){
        console.log("Resuming Session");
        session.resume();
        this.innerHTML = "PAUSE";
    }
    else{
        console.log("Pauseing Session");
        session.pause();
        this.innerHTML = "CONTINUE";
    }
});
stopBt.addEventListener("click", function(){
    console.log("Stoping Session");
    session.stop(); 
});
newBt.addEventListener("click", function(){
    console.log("Reseting Session");
    session.new();
})
downloadBt.addEventListener("click", function(){
    console.log("Downloading Session");
    BIKE.downloadTCX(session.sessionData);
})