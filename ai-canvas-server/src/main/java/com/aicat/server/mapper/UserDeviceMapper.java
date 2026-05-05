package com.aicat.server.mapper;

import com.aicat.server.entity.UserDevice;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserDeviceMapper extends BaseMapper<UserDevice> {
    @Select("SELECT * FROM user_device WHERE user_id = #{userId} FOR UPDATE")
    UserDevice selectForUpdate(Long userId);
}
