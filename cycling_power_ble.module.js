class RevolutionData{
    constructor(){
        this.nonZeroValue = 0;
        this.prevStaleness = true;
        this.prevRevs = null;
        this.prevTime = null;
    }
    reset(){
        this.prevStaleness = true;
        this.prevRevs = null;
        this.prevTime = null;
    }
}

class Bike {
    // Documentation: https://www.bluetooth.com/specifications/specs/gatt-specification-supplement/
    // PageNr: 84
    static FLAG_FIELD = Object.freeze({
        PedalPowerBalance:              {index: 0,  fieldSize: 1},
        PedalPowerBalanceReference:     {index: 1,  fieldSize: 0}, 
        AccumulatedTorque:              {index: 2,  fieldSize: 2}, // -> 1/32 Newton-meter
        AccumulatedTorqueSource:        {index: 3,  fieldSize: 0},
        RevolutionData:                 {index: 4,  fieldSize: 6}, // Struct: [0:4] Cum -> revolutions, [5:6] Time -> 1/2048 s
        CrankRevolutionData:            {index: 5,  fieldSize: 4}, // Struct: [0:2] CumCrank -> revolutions, [3:4] Time -> 1/1024 s
        ExtremeForceMagnitudes:         {index: 6,  fieldSize: 4}, 
        ExtremeTorqueMagnitudes:        {index: 7,  fieldSize: 4}, 
        ExtremeAnglesPresent:           {index: 8,  fieldSize: 3}, 
        TopDeadSpotAngle:               {index: 9,  fieldSize: 2}, 
        BottomDeadSpotAngle:            {index: 10, fieldSize: 2}, 
        AccumulatedEnergy:              {index: 11, fieldSize: 2}, // -> kJ
        OffsetCompensationIndicator:    {index: 12, fieldSize: 0}
        /* Unused flags 13 - 15 */
    });

    static MODES = Object.freeze({
        RAW: 'raw',
        FILTERED: 'filtered'
    });

    constructor(){
        this.self = null;
        this.name = null;
        this._mode = Bike.MODES.RAW;
        this._connecting = false;
        
        this._powerAvailable = false;
        this._speedAvailable = false;
        this._cadenceAvailable = false;

        this._notificationTimestamp = null;
        this._power = 0;
        this._accumulatedEnergy = 0;
        this._accumulatedDistance = 0;
        this._speed = 0;
        this._cadence = 0;  //rpm

        //BLE CHARACTERISTIC VALUES
        this.wheelRevolutionData = new RevolutionData();
        this.crankRevolutionData = new RevolutionData();
    }

    get mode(){ return this._mode; }
    get connecting(){ return this._connecting; }

    get powerAvailable(){ return this._powerAvailable; }
    get speedAvailable(){ return this._speedAvailable; }
    get cadenceAvailable(){ return this._cadenceAvailable; }
    get timestamp(){ return this._notificationTimestamp; }


    #powerBuffer = [];
    #powerFilter = [];
    get power(){
        if (this._mode == Bike.MODES.FILTERED){
            // TODO
        }
        return this._power;
    }

    #speedBuffer = [];
    #speedFilter = [];
    get speed(){
        if (this._mode == Bike.MODES.FILTERED){
            // TODO 
        }
        return this._speed;
    }

    #cadenceBuffer = [];
    #cadenceFilter = [];
    get cadence(){
        if (this._mode == Bike.MODES.FILTERED){
            // TODO
        }
        return this._cadence;
    }

    setMode(mode=Bike.MODES.FILTERED){
        if (
            mode == Bike.MODES.FILTERED ||
            mode == Bike.MODES.RAW
        ){
            this._mode
        }
        else{
            console.warn("Was not able to set BLE bike mode");
        }
    }

    get accumulatedEnergy(){ return this._accumulatedEnergy; }
    get accumulatedDistance(){ return this._accumulatedDistance; }

    #findPayloadIndex(flag, flagIndex){
        if(flag[flagIndex]){
            //Data (payload) index starts at 4 since data index before is the flag field and power ([0:1]-> flag, [2:3]-> power, [4:]-> ?), and data after is dependant on flag field
            let payloadIndex = 4;
            for(var i = 0; i < flagIndex; i++){
                if(flag[i]){
                    payloadIndex += Bike.FLAG_FIELD[this.keys(Bike.FLAG_FIELD)[i]].fieldSize; 
                }
            }
            return payloadIndex;
        }
        else{
            return null;
        }
    }

    connect(){
        this._connecting = true;

        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            const serviceUUID = 0x1818;            //Cycling power
            const characteristicUUID = 0x2A63;     //Cycling power measurement
            var options = {
                filters: [
                    { services: [serviceUUID] }
                ],
                optionalServices: [characteristicUUID]
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name; 
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);                                  // Set up event listener for when device getimeStamp disconnected.
                return device.gatt.connect();                                                                                   // AttemptTimeStamp to connect to remote GATT Server.
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => {
                    const index0multiplier = Math.pow(2, 0);
                    const index1multiplier = Math.pow(2, 8);   
                    const index2multiplier = Math.pow(2,16);
                    const index3multiplier = Math.pow(2,32);

                    let now = new Date().getTime();

                    let dt  = 0; // [s]
                    if(this._notificationTimestamp){
                        dt  = (now - this._notificationTimestamp)/1000; // ms -> s
                    }
                    if(dt > 3){
                        dt  = 0; //Effect: Asume user has disconnected
                    }

                    let flag = event.target.value.getUint8(0) + event.target.value.getUint8(1)*100; // I know this looks wierd, but this is actually how you get the flag field
                    flag = convertTo16BitArray(flag);

                    //Energy
                    if(flag[Bike.FLAG_FIELD._AccumulatedEnergy.index]){
                        let payloadIndex = this.#findPayloadIndex(
                            flag,
                            Bike.FLAG_FIELD._AccumulatedEnergy.index
                        );
                        
                        let data = event.target.value.getUint8(payloadIndex) + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
                        this._accumulatedEnergy = data; // Given in kJ
                        //console.log(data) 
                    }
                    else if(this._powerAvailable){
                        // CONSIDER: find a more reliable method
                        this._accumulatedEnergy += dt*this._power/1000; // J -> kJ
                    }

                    //Power 
                    this._powerAvailable = true;
                    let payloadIndex = 2;
                    this._power = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
                    
                    //Speed & Distance
                    if(flag[Bike.FLAG_FIELD.RevolutionData.index]){
                        this._speedAvailable = true;
                        let payloadIndex = this.#findPayloadIndex(
                            flag,
                            Bike.FLAG_FIELD.RevolutionData.index
                        );

                        let wheelRevs = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier + event.target.value.getUint8(payloadIndex+2)*index2multiplier + event.target.value.getUint8(payloadIndex+3)*index3multiplier;
                        let wheelTime = event.target.value.getUint8(payloadIndex+4)*index0multiplier + event.target.value.getUint8(payloadIndex+5)*index1multiplier;
                        let prevRevs = this.wheelRevolutionData.prevRevs;
                        let prevTime = this.wheelRevolutionData.prevTime;
                        
                        let configuration = 1; //TODO: get from flag field
                        let rpm = 0;
                        
                        if(!this.wheelRevolutionData.prevStaleness){
                            let dTime = wheelTime - prevTime; //TODO: fix roll over
                            let dRevs = wheelRevs - prevRevs;

                            if(dTime > 0){
                                rpm = (configuration ? 2048 : 1024)*60*dRevs/dTime;
                                if(rpm) this.wheelRevolutionData.lastNonZeroValue = rpm;  // CONSIDER: Finding a better solution to speed blips
                            }
                        }
                        else{
                            this.wheelRevolutionData.prevStaleness = false;
                        }
                        if(!rpm && this._power) rpm = this.wheelRevolutionData.lastNonZeroValue;

                        this.wheelRevolutionData.prevRevs = wheelRevs;
                        this.wheelRevolutionData.prevTime = wheelTime;

                        const wheelRadius = 0.311; // [meters] 700x18c
                        const kmh_rpm = 3/25*Math.PI*wheelRadius;
                        this._speed = kmh_rpm*rpm;
                        this._accumulatedDistance = wheelRevs*2*Math.PI*wheelRadius;
                    }        

                    //Cadence
                    if(flag[Bike.FLAG_FIELD.CrankRevolutionData.index]){
                        this._cadenceAvailable = true;
                        let payloadIndex = this.#findPayloadIndex(
                            flag,
                            Bike.FLAG_FIELD.CrankRevolutionData.index
                        );

                        let crankRevs = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
                        let crankTime = event.target.value.getUint8(payloadIndex+2)*index0multiplier + event.target.value.getUint8(payloadIndex+3)*index1multiplier;
                        let prevRevs = this.crankRevolutionData.prevRevs;
                        let prevTime = this.crankRevolutionData.prevTime;

                        let rpm = 0;
                        
                        if(!this.crankRevolutionData.prevStaleness){
                            let dTime = crankTime - prevTime;
                            let dRevs = crankRevs - prevRevs;

                            if(dTime > 0 && dRevs >= 0){    //CONSIDER: finding a better solution to roll over / overflows
                                rpm = 1024*60*dRevs/dTime;
                                if(rpm) this.crankRevolutionData.lastNonZeroValue = rpm;
                            }
                            else{                       
                                rpm = this._cadence;       //Use old value in case of annomolies in the data
                            }
                        }
                        else{
                            this.crankRevolutionData.prevStaleness = false;
                        }

                        this.crankRevolutionData.prevRevs = crankRevs;
                        this.crankRevolutionData.prevTime = crankTime;
                        this._cadence = rpm;
                    }     

                    this._lastNotificationTimestamp = now;  
                    //CONSIDER implement other/more features (as seen in Bike.FLAG_FIELD)
                })
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            }); 
        }

        this._powerAvailable = true;    
        this._connecting = false; //Not _connecting anymore since we now are fully connected 
    }

    onDisconnected(event){
        //const device = event.target;
        this.self = null;
        this.name = null; 

        this._connecting = false;
        this._notificationTimestamp = null;

        this._powerAvailable = false;
        this._speedAvailable = false;
        this._cadenceAvailable = false;
        this._power = 0;
        this._speed = 0;
        this._cadence = 0; 
        this._accumulatedEnergy = 0;
        this._accumulatedDistance = 0;

        this.wheelRevolutionData.reset();
        this.crankRevolutionData.reset();
    }        
}

class HeartRate {
    constructor(){
        this.self = null;
        this.name = null;

        this._heartRate = null;
        this._accumulatedHeartBeats = 0;
        this._notificationTimestamp = null;
    }
    get heartRate(){
        return this._heartRate;
    }
    get accumulatedHeartBeats(){
        return Math.floor(this._accumulatedHeartBeats);
    }

    connect(){
        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            var serviceUUID = 0x180D;            //Heart Rate UUID
            var characteristicUUID = 0x2A37;     //Heart Rate Masurement
            var options = {
                filters: [
                    { services: [serviceUUID] }
                ],
                optionalServices: [characteristicUUID]
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name;
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);
                return device.gatt.connect();
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => {
                    let now = new Date().getTime();
                    let dt = (now - this._notificationTimestamp)/1000; // [s]
                    if (dt > 0 && dt < 6){
                        let beats = dt/60*this._heartRate;
                        this._accumulatedHeartBeats += beats;
                    }
                    this._notificationTimestamp = now;
                    this._heartRate = event.target.value.getUint8(1); // TODO: Fix -> Max heartrate 255, then rollover
                });        
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            });
        }
    }
    onDisconnected(event){
        //const device = event.target;
        this.self = null;
        this.name = null;
        this.heartRate = null;
        this._notificationTimestamp = null;
    }

    resetAccumulator(){
        this._accumulatedHeartBeats = 0;
    }
    
}

class SRAT {
    constructor(){
        this.self = null;
        this.name = null;
        this._connecting = false;
        this.mode = 0;
        this.bts  = [false, false, false, false, false, false];
        this.axis = {a1: 0, a2: 0, roll: 0, pitch: 0, yaw: 0};
    }
    connect(){
        this._connecting = true;
        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            var serviceUUID = "be30f8d4-4711-11ee-be56-0242ac120002";            //SRAT+ Service
            var characteristicUUID = "be30f8d4-4711-11ee-be56-0242ac120003";     //SRAT+ Output Characteristic
            var options = {
                acceptAllDevices: true,
                // filters: [
                //     { services: [serviceUUID] }
                // ],
                optionalServices: [serviceUUID, characteristicUUID]
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name; 
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);                                  // Set up event listener for when device getimeStamp disconnected.
                return device.gatt.connect();                                                                                   // AttemptTimeStamp to connect to remote GATT Server.
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => this.#notifyHandler(event, this));  
                this._connecting = false; //Not _connecting anymore since we now are fully connected 
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            });
        }
        else{
            this._connecting = false;
        }
    }
    onDisconnected(event){
        this.self = null;
        this.name = null;
        this._connecting = false;
        this.mode = 0;
        this.bts  = [false, false, false, false, false, false];
        this.axis = {a1: 0, a2: 0, roll: 0, pitch: 0, yaw: 0};
    }
    #notifyHandler(event, object){  
        object.mode = event.target.value.getUint8(0) >> 6;
        let tmp = event.target.value.getUint8(0);
        for(var i = 0; i < 6; i++){
            object.bts[i] = (tmp & 0b1) ? true : false;
            tmp = tmp >> 1;
        }
        object.axis.a1 = event.target.value.getUint8(1);
        object.axis.a2 = event.target.value.getUint8(2);
        object.axis.roll = event.target.value.getUint8(3);
        object.axis.pitch = event.target.value.getUint8(4);
        object.axis.yaw = event.target.value.getUint8(5);
    }
}


class SessionData{
    constructor(){
        this.restart();
    }

    static TYPES = Object.freeze({
        LAP: 'lap',
        TOTAL: 'total'
    })

    restart(){
        this._sample = false;
        this._timeStart = 0; // Given in Epoch -> new Date().getTime();
        this._timeEnd = 0;   // Given in Epoch -> new Date().getTime(); TODO: Consider removing since it is ambiguous

        this._laps = [0];    // Given in dt [s] since timeStart
        this._lapIndex = 0;
        
        // Data Matrix
        this._hr = [];
        this._power = [];
        this._cadence = [];
        this._speed = [];
        this._accumulatedTime = [];
        this._accumulatedDistance = [];
        this._accumulatedEnergy = [];
        this._accumulatedHeartBeats = [];

        // Storing for easy retrieving without searching
        this._maxPwr = 0;
        this._maxPulse = 0;
        this._maxCadance = 0;
        this._maxSpeed = 0;
        this._lapMaxPwr = 0;
        this._lapMaxPulse = 0;
        this._lapMaxCadence = 0;
        this._lapMaxSpeed = 0;
    }

    get startTime(){
        return this._timeStart;
    }

    start(){
        if (this._timeStart != 0) return;
        this.timeStart = new Date().getTime();
        this._sample = true;
    }
    stop(){
        if (this._timeEnd != 0) return;
        this._timeEnd = new Date().getTime();
        this._sample = false;
    }
    lap(){
        if(this.timeStart == 0) return;
        let dt = (new Date().getTime() - this.timeStart)/1000; // [s]
        this._laps.push(dt);
        this._lapIndex = this._power.length-1; // Can be any of the data-arrays as they all should have the same length
        this._lapMaxPwr = 0;
        this._lapMaxPulse = 0;
        this._lapMaxCadence = 0;
        this._lapMaxSpeed = 0;
    }

    sample(pwr, cadence = null, speed = null, accDist = null, accEnergy = null, hr = null, accHr = null){
        if(!this._sample) return;
        if(pwr == undefined || pwr == null) return;
        
        let dt = new Date().getTime() - this.timeStart;

        this._power.push(pwr);
        this._cadence.push(cadence);
        this._speed.push(speed);
        this._accumulatedDistance.push(accDist);
        this._accumulatedEnergy.push(accEnergy);
        this._hr.push(hr);
        this._accumulatedHeartBeats.push(accHr);
        this._accumulatedTime.push(dt);

        if (pwr && pwr > this.maxPwr) this.maxPwr = pwr;
        if (cadence && cadence > this.maxCadance) this.maxCadance = cadence;
        if (hr && hr > this.maxPulse) this.maxPulse = hr;
        if (speed && speed > this.maxSpeed) this.maxSpeed = speed;

        if (pwr && pwr > this.lapMaxPwr) this.lapMaxPwr = pwr;
        if (cadence && cadence > this.lapMaxCadance) this.lapMaxCadance = cadence;
        if (hr && hr > this.lapMaxPulse) this.lapMaxPulse = hr;
        if (speed && speed > this.lapMaxSpeed) this.lapMaxSpeed = speed;
    }

    //max, average
    getPower(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this._power, this._accumulatedTime, 0, this._power.lenght-1);
            return {max: this._maxPwr, avg: readThrough.sum/readThrough.dt}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this._power, this._accumulatedTime, this._lapIndex, this._power.lenght-1)
            return {max: this._lapMaxPwr, avg: readThrough.sum/readThrough.dt}
        }
        else{
            return null;
        }
    }
    getSpeed(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this._speed, this._accumulatedTime, 0, this._speed.length-1);
            return {max: this._maxSpeed, avg: readThrough.sum/readThrough.dt}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this._speed, this._accumulatedTime, this._lapIndex, this._speed.length-1)
            return {max: this._lapMaxSpeed, avg: readThrough.sum/readThrough.dt}
        }
        else{
            return null;
        }
    }
    getCadence(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this._cadence, this._accumulatedTime, 0, this._cadence.length-1);
            return {max: this._maxCadance, avg: readThrough.sum/readThrough.dt}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this._cadence, this._accumulatedTime, this._lapIndex, this._cadence.length-1)
            return {max: this._lapMaxCadence, avg: readThrough.sum/readThrough.dt}
        }
        else{
            return null;
        }
    }
    getHeartBeats(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this._hr, this._accumulatedTime, 0, this._hr.length-1);
            return {max: this._maxPulse, avg: readThrough.sum/readThrough.dt}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this._hr, this._accumulatedTime, this._lapIndex, this._hr.length-1)
            return {max: this._lapMaxPulse, avg: readThrough.sum/readThrough.dt}
        }
        else{
            return null;
        }
    }

    // acc, phr
    getDistance(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this._accumulatedDistance, this._accumulatedTime, 0, this._accumulatedDistance.length-1);
            let distance = readThrough.end-readThrough.start;
            return {acc: distance, phr: distance/readThrough.dt*3600}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this._accumulatedDistance, this._accumulatedTime, this._lapIndex, this._accumulatedDistance.length-1);
            let distance = readThrough.end-readThrough.start;
            return {acc: distance, phr: distance/readThrough.dt*3600}
        }
        else{
            return null;
        }
    }
    getEnergy(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this._accumulatedEnergy, this._accumulatedTime, 0, this._accumulatedEnergy.length-1);
            let energy = readThrough.end-readThrough.start;
            return {acc: energy, phr: energy/readThrough.dt*3600}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this._accumulatedEnergy, this._accumulatedTime, this._lapIndex, this._accumulatedEnergy.length-1);
            let energy = readThrough.end-readThrough.start;
            return {acc: energy, phr: energy/readThrough.dt*3600}
        }
        else{
            return null;
        }
    }


    #readThrough(array, timeArray, startIndex, endIndex){
        if(array.length != timeArray.length) return null;
        let start = null;
        let end = null;
        let sum = 0;
        let timeTotal = 0;
        for(var i = startIndex; i <= endIndex; i++){
            let nextIndex = i+1;
            if (nextIndex > endIndex || nextIndex >= timeArray.length) continue;
            let dt = timeArray[nextIndex]
            if (dt <= 0) continue;
            dt = dt > 3 ? 1 : dt; // If the next 
            let value = array[i];
            if (value == null) continue;
            if (start == null) start = value;
            end = value;
            sum += dt*value;
        }
        start = start == null ? 0 : start;
        end = end == null ? 0 : end;
        timeTotal = timeTotal <= 0 ? 1: timeTotal; // Avoid devide by zero
        return {start: start, end: end, sum: sum, dt: timeTotal};
    }

    getSessionDataAsJSON(){
        let data = {
            startTime: this._timeStart,
            laps: this._laps,
            
            time: this._accumulatedTime,
            power: this._power,
            cadence: this._cadence,
            speed: this._speed,
            accumulatedDistance: this._accumulatedDistance,
            accumulatedEnergy: this._accumulatedEnergy,
            heartRate: this._hr
        }
        return JSON.stringify(data);
    }
}

class Session{
    constructor(){
        this.bike = new Bike();
        this.bike.setMode(Bike.MODES.FILTERED);
        this.hr = new HeartRate();
        this.steeringWheel = new SRAT();
        this.sessionData = new SessionData();

        this.sampleRateMS = 490; // From nyquist sampling theorem -> the frequency we are measuring is promissed at 1 pr. second. We should then sample check wheter or not to store the current signal 2 times that frequency so that we do not miss out on any one data-point. By setting it 10 ms before we are conservative.
        this._sample = false;
        this._lastSampleTimestamp = {bike: null, hr: null};
        this._started = false;
        this._ended = false;
        this.#sampleLoop(true);
    }

    get epochStartTime(){
        return this.sessionData.startTime;
    }

    new(){
        this.sessionData = new SessionData();
        this._started = false;
        this._ended = false;
    }

    start(){
        if(!bluetooth_available()) {
            alert("Bluetooth module initiated, however, your browser do not support bluetooth! [Consider changing to chrome]");
            return;
        }
        this.sessionData.start();
        this._sample = true;
    }
    pause(){
        this._sample = false;
    }
    resume(){
        if(this._started){
            this._sample = true;
        }
    }
    stop(){
        this.sessionData.stop();
        this._sample = false;
        this._ended = true;
    }
    getStats(){
        let current = {
            power: this.bike.power,
            speed: this.bike.speed,
            cadence: this.bike.cadence,
            heartRate: this.hr.heartRate
        }
        let power = this.sessionData.getPower(SessionData.TYPES.LAP);
        let speed = this.sessionData.getSpeed(SessionData.TYPES.LAP);
        let cadence = this.sessionData.getCadence(SessionData.TYPES.LAP);
        let heartRate = this.sessionData.getHeartBeats(SessionData.TYPES.LAP);
        let distance = this.sessionData.getDistance(SessionData.TYPES.LAP);
        let energy = this.sessionData.getEnergy(SessionData.TYPES.LAP);
        let lap = {
            power: { max: power.max, avg: power.avg },
            speed: { max: speed.max, avg: speed.avg },        
            cadence: { max: cadence.max, avg: cadence.avg },  
            heartRate: { max: heartRate.max, avg: heartRate.avg },
            distance: { acc: distance.acc, phr: distance.phr },
            energy: { acc: energy.acc, phr: energy.phr }
        };
        power = this.sessionData.getPower(SessionData.TYPES.TOTAL);
        speed = this.sessionData.getSpeed(SessionData.TYPES.TOTAL);
        cadence = this.sessionData.getCadence(SessionData.TYPES.TOTAL);
        heartRate = this.sessionData.getHeartBeats(SessionData.TYPES.TOTAL);
        distance = this.sessionData.getDistance(SessionData.TYPES.TOTAL);
        energy = this.sessionData.getEnergy(SessionData.TYPES.TOTAL);
        let total = {
            power: { max: power.max, avg: power.avg },
            speed: { max: speed.max, avg: speed.avg },        
            cadence: { max: cadence.max, avg: cadence.avg },  
            heartRate: { max: heartRate.max, avg: heartRate.avg },
            distance: { acc: distance.acc, phr: distance.phr },
            energy: { acc: energy.acc, phr: energy.phr }
        }
        return {total: total, lap: lap, current: current};
    }

    #sampleLoop(loop = false){
        if (loop) {
            setTimeout(() => this.#sampleLoop(), this.sampleRateMS);
        }
        if (!this._sample){
            return;
        }        
        
        let now = new Date().getTime();

        let hr = null;
        let accHr = null;

        if(this.hr.self != null){
            hr = this.hr.heartRate;
            accHr = this.hr.accumulatedHeartBeats;

        }

        if(this.bike.self != null && this.bike.timestamp != this._lastSampleTimestamp.bike){
            this.sessionData.sample(
                this.bike.power,
                this.bike.cadence,
                this.bike.speed,
                this.bike.accumulatedDistance,
                this.bike.accumulatedEnergy,
                hr,
                accHr
            );
            this._lastSampleTimestamp.bike = this.bike.timestamp;
        }     
        
        const WatchDogTimeout = {bike: 60*1000, hr: 6*1000}
        if (this.bike.timestamp && now > this.bike.timestamp + WatchDogTimeout.bike) this.bike.onDisconnected();
        if (this.hr.timestamp && now > this.hr.timestamp + WatchDogTimeout.hr) this.hr.onDisconnected();
    }
}

//////////////////////////////
///    Helper functions    ///
//////////////////////////////

function convertTo16BitArray(x){
    // index 0 is LSB 
    if ( x < 0  || x >= Math.pow(2, 16)) { return []; }
    let returnArray = []
    for(let i = 15; i >= 0; i--){
        let dec = Math.pow(2, i);
        if(dec <= x){
            x -= dec;
            returnArray.unshift(1);
        }
        else{
            returnArray.unshift(0);
        }
    }
    return returnArray;
}

function Joule2Cal(joules){
    return 0.239005736*joules;
}

function formatTime(ms, displayMS = false){
    var isNegative = ms < 0;
    ms = Math.abs(ms);
    let h = 60*60*1000;
    let m = 60*1000;
    let s = 1000;
    var hours = Math.floor(ms/h);
    ms -= hours*h;
    var minutes = Math.floor(ms/m);
    ms -= minutes*m;
    var seconds = Math.floor(ms/s);
    ms -= seconds*s;
    if (hours < 10) hours = "0"+hours;
    if (minutes < 10) minutes = "0"+minutes;
    if (seconds < 10) seconds = "0"+seconds;
    
    let time = (isNegative?"- ":"")+hours+":"+minutes+":"+seconds;
    if (displayMS) {
        if (ms < 10){
            ms = "00"+ms;
        } 
        else if(ms < 100){
            ms = "0"+ms;
        }
        else{
            ms = ""+ms;
        }
        time += "."+ms[0]+ms[1];
    }
    return time;
}

function findClosestIndex(timeArray, timestamp){
    let i = 0;
    for(i = 0; i < timeArray.length; i++){
        if(timeArray[i] == timestamp) return i;
        if(timeArray[i] > timestamp) return Math.abs(timeArray[i-1] - timestamp) < Math.abs(timeArray[i][1] - timestamp) ? i-1 : i;
    }
    return i;
}
function readThrough(dataArray, timeArray, startIndex = 0, endIndex = undefined, tolerance = 3){
    // TODO
    return {
        start: '',
        end: '',
        max: '',
        weightedSum: '',
        time: {work: '', elapsed: ''}
    };
}

function bluetooth_available(){
    return navigator.bluetooth;
}

function convertTimestampToISOString(timestamp) {
    const date = new Date(timestamp); // Create a Date object from the timestamp
    const isoString = date.toISOString(); // Get the ISO string (e.g., '2023-10-15T12:00:00.000Z')
    return isoString.slice(0, 19) + 'Z'; // Remove milliseconds and return the formatted string
}

function downloadTCX(sessionData){
    if (!(sessionData instanceof SessionData)) {
        throw new Error(`Expected an instance of ${SessionData.name}, but received ${sessionData.constructor.name}`);
    }

    // If there are no datapoint return before download
    if(!sessionData._accumulatedTime.length) return;

    // START A TCX FILE CONTAINING THE SESSION
    let tcxData = `<?xml version="1.0" encoding="UTF-8"?>
    <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
        <Activities>
            <Activity Sport="Biking">
                <Id>`+convertTimestampToISOString(sessionData.timeStart)+`</Id>`;
    
    // LOOP OVER ALL LAPS
    let trackpointIndex = 0; // Global index of all the sample points
    for(var i = 0; i < sessionData.laps.length; i++){
        // TODO: handle null events
        const dtStart = sessionData.laps[i];
        const dtEnd = i < sessionData.laps.length-1 ? sessionData.laps[i+1] : sessionData.timeEnd - sessionData.timeStart;
        
        const startTime = sessionData.timeStart + dtStart;
        const endTime = (i < sessionData.laps.length-1) ? startTime+sessionData.laps[i+1] : sessionData.timeEnd;    
        const lapTimeSeconds = Math.round((endTime - startTime)/1000);

        const startIndex = trackpointIndex;
        const endIndex = i < sessionData.laps.length-1 ? findClosestIndex(sessionData._accumulatedTime, dtEnd): sessionData._accumulatedTime.length-1;

        const startDistance = sessionData._accumulatedDistance[startIndex];
        const endDistance = sessionData._accumulatedDistance[endIndex];
        const distance = Math.round((endDistance-startDistance));

        const startEnergy = sessionData._accumulatedEnergy[startIndex];
        const endEnergy = sessionData._accumulatedEnergy[endIndex];

        const calories = Math.round((endEnergy-startEnergy)*0.2390057361); // kJoule to kCal convertion

        // START A LAP CONSISTING OF A TRACK
        let lap = `<Lap StartTime="`+convertTimestampToISOString(startTime)+`">
                    <TotalTimeSeconds>`+lapTimeSeconds+`</TotalTimeSeconds>
                    <DistanceMeters>`+distance+`</DistanceMeters>
                    <Calories>`+calories+`</Calories>
                    <Track>`;

        // ADD ALL TRACK POINTS
        let dt = sessionData._accumulatedTime[trackpointIndex];
        while(dt <= dtEnd){            
            let trackpoint = `<Trackpoint>
                <Time>`+convertTimestampToISOString(startTime+dt)+`</Time>`;
            
            // CONSIDER: implementing
            // if (false){ 
            //     trackpoint += `<AltitudeMeters>0</AltitudeMeters>`;
            // }

            if(sessionData.hr[trackpointIndex] != null){
                trackpoint += `<HeartRateBpm>`+Math.round(sessionData.hr[trackpointIndex])+`</HeartRateBpm>`;
            }
            if(sessionData._accumulatedDistance[trackpointIndex] != null){
                let trpt_distance = Math.floor((sessionData._accumulatedDistance[trackpointIndex]-startDistance));
                trackpoint += `<DistanceMeters>`+trpt_distance+`</DistanceMeters>`;
            }
            if(sessionData._cadence[trackpointIndex] != null){
                trackpoint += `<Cadence>`+Math.round(sessionData._cadence[trackpointIndex])+`</Cadence>`;
            }
            if(sessionData.pwr[trackpointIndex] != null){
                trackpoint += `<Watts>`+Math.round(sessionData.pwr[trackpointIndex])+`</Watts>`;
            }
            
            trackpoint += `</Trackpoint>`;
            lap += trackpoint;

            // Iterate
            trackpointIndex++;            
            if(trackpointIndex > sessionData._accumulatedTime.length) {
                console.error("Download data corrupted");
                break; // Something has gone wrong at this point [Should never happen]
            }
            dt = sessionData._accumulatedTime[trackpointIndex];            
        }

        // END OF LAP
        lap += `</Track></Lap>`;
        // ADD LAP TO SESSION
        tcxData += lap;
    }
    // END OF SESSION
    tcxData += `</Activity></Activities></TrainingCenterDatabase>`;
    
    const blob = new Blob([tcxData], { type: 'application/xml' });
    // Create a download link
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'activity.tcx'; // File name
    document.body.appendChild(a);
    a.click();

    // Cleanup
    window.URL.revokeObjectURL(url);
}

export {Session, SessionData, Bike, HeartRate, downloadTCX, Joule2Cal, formatTime, findClosestIndex, bluetooth_available}